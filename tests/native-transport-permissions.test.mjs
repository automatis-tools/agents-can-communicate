import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { createAccChannel, endpointDir } from "../packages/adapter-claude-code/src/channel.mjs";
import { offerMessage } from "../packages/adapter-claude-code/src/native-delivery.mjs";
import { createFakeClock, createFakeIds, createMemoryStore } from "./helpers/memory-store.mjs";

for (const code of ["EPERM", "EACCES"]) {
  test(`${code} while connecting preserves a permission diagnosis through router and receipts`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "acc-permission-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const channel = createAccChannel({ endpointDir: endpointDir(root), clientPid: process.pid,
      write: () => {}, routeReply: async () => {}, routeAck: async () => {} });
    await channel.listen();
    t.after(() => channel.close());
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
      generation: receiver.generation, adapterId: "claude_code", clientVersion: "2.1.267",
      availableModes: ["livePush"], livePolicy: "actionable", opaqueEndpointRef: channel.endpointId,
      leaseUntil: new Date(Date.now() + 60_000).toISOString() });
    // A real live endpoint with an OS connection failure at the sender boundary.
    const connect = () => {
      const socket = new net.Socket();
      queueMicrotask(() => socket.emit("error", Object.assign(new Error("private socket path"), { code })));
      return socket;
    };
    const adapter = { id: "claude_code", capabilities: { delivery: { livePush: true } },
      nativeDelivery: {}, offerMessage: input => offerMessage({ ...input, runtimeDir: root, connect }) };
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

test("macOS channels keep the same short socket namespace across client TMPDIR values", {
  skip: process.platform !== "darwin",
}, async t => {
  const root = await mkdtemp("/private/tmp/acc-channel-location-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = process.env.TMPDIR;
  let channel;
  try {
    process.env.TMPDIR = root;
    channel = createAccChannel({ endpointDir: endpointDir(root), clientPid: process.pid,
      write: () => {}, routeReply: async () => {}, routeAck: async () => {} });
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
  await channel.listen();
  t.after(() => channel.close());
  const record = JSON.parse(await readFile(path.join(endpointDir(root), `${channel.endpointId}.json`)));
  assert.equal(path.dirname(record.socketPath), `/tmp/acc-ch-${process.getuid()}`);
});
