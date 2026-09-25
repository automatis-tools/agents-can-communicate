import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { channelSocketDirectory } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { bindNativeSession, offerMessage } from "../packages/adapter-claude-code/src/inbox-delivery.mjs";
import { createFakeClock, createFakeIds, createMemoryStore } from "./helpers/memory-store.mjs";

// A real inbox endpoint: a listening socket, Claude's registry entry for it,
// and ACC's endpoint record, so the only failure left is the connection.
async function inboxEndpoint(t) {
  const root = mkdtempSync("/tmp/acc-permission-");
  const server = net.createServer(() => {});
  t.after(() => new Promise(resolve => server.close(() => {
    rmSync(root, { recursive: true, force: true });
    resolve();
  })));
  const socket = path.join(root, "s.sock");
  await new Promise(resolve => server.listen(socket, resolve));
  chmodSync(socket, 0o600);
  const configDir = path.join(root, "claude");
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  writeFileSync(path.join(configDir, "sessions", "4242.json"),
    JSON.stringify({ pid: 4242, sessionId: "session-x", messagingSocketPath: socket }));
  const runtimeDir = path.join(root, "runtime");
  const handshake = await bindNativeSession({ event: { sessionId: "session-x" }, clientPid: 4242,
    clientVersion: "2.1.282", runtimeDir,
    env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_MESSAGING_SOCKET: socket } });
  return { runtimeDir, endpointId: handshake.opaqueEndpointRef };
}

for (const code of ["EPERM", "EACCES"]) {
  test(`${code} while connecting preserves a permission diagnosis through router and receipts`, async t => {
    const endpoint = await inboxEndpoint(t);
    const clock = createFakeClock(new Date().toISOString());
    const ids = createFakeIds();
    const workspaceId = "workspace_permission";
    const store = createMemoryStore({ clock, ids, workspaceId });
    const service = createCoordinationService({ store, clock, ids });
    const session = participantId => service.openSession({ workspaceId, participantId,
      harness: "fixture", heartbeatCadenceMs: 30_000 });
    const sender = await session("sender");
    const receiver = await session("receiver");
    await service.publishDeliveryBinding({ sessionId: receiver.sessionId,
      generation: receiver.generation, adapterId: "claude_code", clientVersion: "2.1.282",
      availableModes: ["livePush"], livePolicy: "actionable", opaqueEndpointRef: endpoint.endpointId,
      leaseUntil: new Date(Date.now() + 60_000).toISOString() });
    // A real live endpoint with an OS connection failure at the sender boundary.
    const connect = () => {
      const socket = new net.Socket();
      queueMicrotask(() => socket.emit("error", Object.assign(new Error("private socket path"), { code })));
      return socket;
    };
    const adapter = { id: "claude_code", capabilities: { delivery: { livePush: true } },
      nativeDelivery: {}, offerMessage: input => offerMessage({ ...input, runtimeDir: endpoint.runtimeDir,
        connect }) };
    const router = createDeliveryRouter({ service, clock, adapters: [adapter] });
    const message = await service.sendMessage({ sessionId: sender.sessionId,
      generation: sender.generation, toParticipantIds: ["receiver"], kind: "request",
      obligation: "reply", subject: "permission probe", body: "synthetic",
      clientMessageId: `client_${code}`, artifacts: [], inReplyTo: null });
    const [delivery] = await router.offer(message);
    assert.equal(delivery.errorCode, "transport_permission_denied");
    assert.equal(delivery.outcome, "queued");
    assert.equal((await service.readReceipt({ messageId: message.messageId,
      recipientParticipantId: "receiver" })).state, "queued");
    const events = (await store.eventsSince(workspaceId, null, 100)).events;
    const failed = events.find(event => event.type === "message.offer_failed");
    assert.equal(failed.payload.safeErrorCode, "transport_permission_denied");
    assert.equal(JSON.stringify(failed).includes("private socket path"), false);
  });
}

test("the short socket namespace ignores the client's TMPDIR on macOS", {
  skip: process.platform !== "darwin",
}, () => {
  const before = process.env.TMPDIR;
  try {
    process.env.TMPDIR = "/private/tmp/acc-some-client-tmpdir";
    assert.equal(channelSocketDirectory(), `/tmp/acc-ch-${process.getuid()}`);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});
