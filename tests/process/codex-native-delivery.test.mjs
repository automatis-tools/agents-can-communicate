import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bindNativeSession, offerMessage }
  from "../../packages/adapter-codex/src/native-delivery.mjs";
import { acceptKey, decodeFrames, encodeFrame } from "../../packages/adapter-codex/src/ws-json-rpc.mjs";

const THREAD = "01a063ed-a384-7fe2-b443-7fedf1593f6b";

// macOS caps a Unix socket path at 104 bytes, and the client dictates a 42-byte
// suffix here: `app-server-control/app-server-control.sock`. A macOS runner's
// TMPDIR is around 48 (`/var/folders/../T/`), so binding under it fails with a
// bare `EINVAL` - which passed on a laptop with a short TMPDIR and failed on CI.
const shortTmp = () => (process.platform === "win32" ? tmpdir() : "/tmp");

// A fake daemon at the real control-socket path under a temp CODEX_HOME, so the
// adapter's own socket discovery and WebSocket client are exercised end to end.
async function daemon(t, { cwd }) {
  const home = await realpath(await mkdtemp(path.join(shortTmp(), "acc-cx-nd-")));
  await mkdir(path.join(home, "app-server-control"), { recursive: true });
  const socketPath = path.join(home, "app-server-control", "app-server-control.sock");
  assert.ok(Buffer.byteLength(socketPath) < 104,
    `socket path is too long for this platform: ${socketPath}`);
  const server = http.createServer((request, response) => response.writeHead(404).end());
  const state = { queue: [], loaded: ["other", THREAD], cwd, version: "0.152.1", calls: [] };
  const sockets = new Set();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
      + `Sec-WebSocket-Accept: ${acceptKey(request.headers["sec-websocket-key"])}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = Buffer.from(rest);
      for (const frame of frames) {
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString("utf8"));
        state.calls.push({ method: message.method, threadId: message.params?.threadId });
        if (message.id === undefined) continue;
        const reply = result => socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0",
          id: message.id, result }), { mask: false }));
        if (message.method === "initialize") reply({ userAgent: `acc/${state.version} (Mac OS)` });
        else if (message.method === "thread/loaded/list") reply({ data: state.loaded, nextCursor: null });
        else if (message.method === "thread/list") reply({ data: [{ id: "other", cwd: state.cwd, status: { type: "idle" } }, { id: THREAD, cwd: state.cwd,
          status: { type: "idle" } }], nextCursor: null });
        else if (message.method === "thread/queue/list") reply({ data: state.queue.filter(item => item.threadId === message.params.threadId), nextCursor: null });
        else if (message.method === "thread/queue/add") {
          const item = { threadId: message.params.threadId, id: `qs_${state.queue.length + 1}`,
            clientUserMessageId: message.params.clientUserMessageId, input: message.params.input };
          state.queue.push(item);
          reply({ queuedSubmission: item });
        } else reply({});
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const s of sockets) s.destroy();
    await new Promise(done => server.close(done)); await rm(home, { recursive: true, force: true }); });
  return { env: { CODEX_HOME: home }, state, home };
}

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
