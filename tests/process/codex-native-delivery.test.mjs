import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bindNativeSession, offerMessage }
  from "../../packages/adapter-codex/src/native-delivery.mjs";
import { controlledCodexDaemon as daemon, THREAD } from "../helpers/codex-daemon.mjs";
const shortTmp = () => (process.platform === "win32" ? tmpdir() : "/tmp");

async function directory(t) {
  const dir = await realpath(await mkdtemp(path.join(shortTmp(), "acc-native-runtime-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Both sockets are real; the sender points at a different daemon. Only the
// receiver's private registration may decide where the durable message goes.
test("native binding selects the exact receiver thread and socket through real transport", async t => {
  const runtimeDir = await directory(t);
  const cwd = await directory(t);
  const receiver = await daemon(t, { cwd });
  const sender = await daemon(t, { cwd });
  const bound = await bindNativeSession({ event: { sessionId: THREAD, cwd },
    clientPid: process.pid, clientVersion: "0.152.1", runtimeDir, env: receiver.env });
  assert.equal(bound.supported, true);
  assert.match(bound.opaqueEndpointRef, /^codex_endpoint_[a-f0-9]{32}$/);
  const binding = { opaqueEndpointRef: bound.opaqueEndpointRef, clientVersion: "0.152.1" };
  const offer = () => offerMessage({ binding, runtimeDir, env: sender.env,
    message: { messageId: "message_1", kind: "question", subject: "Native?", body: "synthetic body" } });
  assert.equal((await offer()).accepted, true);
  assert.equal((await offer()).accepted, true);
  assert.equal(sender.state.queue.length, 0);
  assert.equal(receiver.state.queue.length, 1, "pending retry must preserve the submission");
  assert.equal(receiver.state.queue[0].threadId, THREAD);
  assert.equal(receiver.state.queue[0].clientUserMessageId, "message_1");
  assert.match(receiver.state.queue[0].input[0].text, /untrusted peer content/);
  assert.equal(receiver.state.calls.some(call => /thread\/read|thread\/resume|turn\/start/.test(call.method)), false);
  receiver.state.cwd = await directory(t);
  assert.equal((await offer()).accepted, false, "a changed cwd must revoke transport reachability");
  assert.equal(receiver.state.queue.length, 1);
  receiver.state.cwd = cwd;
  receiver.state.loaded = ["other"];
  assert.equal((await offer()).accepted, false, "a different loaded thread is not the receiver");
  assert.equal(sender.state.calls.length, 0, "sender environment must never choose the socket");
});

test("with the daemon down the binding and offer fall back durably", async t => {
  const runtimeDir = await directory(t);
  const env = { CODEX_HOME: path.join(runtimeDir, "absent-daemon") };
  const bound = await bindNativeSession({ event: { sessionId: THREAD, cwd: runtimeDir },
    clientPid: process.pid, clientVersion: "0.152.1", runtimeDir, env });
  assert.deepEqual([bound.supported, bound.reasonCode], [false, "handshake_failed"]);
  const offer = await offerMessage({ binding: { opaqueEndpointRef: THREAD,
    clientVersion: "0.152.1" }, message: { messageId: "m", kind: "note", body: "x" }, runtimeDir, env });
  assert.equal(offer.safeErrorCode, "recipient_unavailable");
});
