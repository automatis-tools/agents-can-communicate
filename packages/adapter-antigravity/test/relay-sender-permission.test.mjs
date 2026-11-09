import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { offerMessage, refreshNativeSession } from "../src/native-delivery.mjs";
import { createRelay } from "../src/relay.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

const CONVERSATION = "3ed65ea5-31f2-4ddf-b6c7-e3c85a9a3c29";
const alive = () => true;
const message = { messageId: "message_q1", kind: "request", subject: "Lane", body: "Your turn" };

async function listeningRelay(t) {
  const runtimeDir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-sp-")));
  const socketDir = path.join("/tmp", `acc-sp-${randomBytes(4).toString("hex")}`);
  const relay = createRelay({ runtimeDir, socketDir, conversationId: CONVERSATION, agyPid: 4242,
    relayPid: process.pid, clientVersion: "1.2.7", isAlive: alive,
    api: { sendMessage: async () => ({ ok: true, reasonCode: null }),
      conversationMetadata: async () => ({ ok: true, reasonCode: null }) } });
  t.after(async () => { await relay.close("test_end");
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true }); });
  const { endpointId } = await relay.listen();
  return { runtimeDir, binding: { opaqueEndpointRef: endpointId, clientVersion: "1.2.7" } };
}

// A client sandbox refuses connect(2) on the relay's socket: Codex's workspace mode
// answers EPERM on macOS. The relay itself is fine and the file is still there.
function refuseConnections(t, code) {
  t.mock.method(net, "createConnection", () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => socket.emit("error", Object.assign(new Error(`connect ${code}`), { code })));
    return socket;
  });
}

for (const code of ["EPERM", "EACCES"]) {
  test(`an offer refused with ${code} names the sender's permissions, so the sender can retry`, async t => {
    const { runtimeDir, binding } = await listeningRelay(t);
    refuseConnections(t, code);

    const offered = await offerMessage({ binding, message, runtimeDir });

    assert.equal(offered.accepted, false);
    assert.equal(offered.safeErrorCode, "transport_permission_denied");
  });

  test(`a lease refresh refused with ${code} names the sender's permissions too`, async t => {
    const { runtimeDir, binding } = await listeningRelay(t);
    refuseConnections(t, code);

    const refreshed = await refreshNativeSession({ binding, runtimeDir, isAlive: alive });

    assert.equal(refreshed.supported, false);
    assert.equal(refreshed.reasonCode, "transport_permission_denied");
  });
}

test("any other connection error stays a transport error", async t => {
  const { runtimeDir, binding } = await listeningRelay(t);
  refuseConnections(t, "ECONNRESET");

  const offered = await offerMessage({ binding, message, runtimeDir });

  assert.equal(offered.safeErrorCode, "transport_error");
});
