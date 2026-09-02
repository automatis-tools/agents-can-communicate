import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { addCodexQueueMessage, compareStableVersions, isMethodMissing, locateCodexThread,
  openCodexAppServer, probeCodexQueue, safeReason, serverVersionOf }
  from "../src/app-server-client.mjs";
import { acceptKey, decodeFrames, encodeFrame } from "../src/ws-json-rpc.mjs";

const THREAD = "01a063ed-a384-7fe2-b443-7fedf1593f6b";
const CWD = "/work/capture";
const SECRET_PREVIEW = "SECRET-PREVIEW-3f2a must never surface";
const USER_AGENT = "agents-can-communicate/0.152.1 (Mac OS 26.6.2; arm64) Apple_Terminal";

// A fake daemon: HTTP upgrade on a Unix socket, then one JSON-RPC message per
// text frame, exactly as codex-cli 0.152.1 answered.
function startDaemon({ userAgent = USER_AGENT, loaded = [THREAD], threads, queue = [],
  queueSupported = true, missingCode = -32601 } = {}) {
  const state = { queue: [...queue] };
  const dir = mkdtempSync(path.join(tmpdir(), "acc-codex-daemon-"));
  const socketPath = path.join(dir, "control.sock");
  const server = http.createServer((request, response) => response.writeHead(404).end());
  const sockets = new Set();
  const rpcError = (code, message) => ({ code, message });
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
        if (frame.opcode === 8) { socket.end(); return; }
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString("utf8"));
        const reply = payload => socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0",
          ...payload }), { mask: false }));
        server.calls.push(message.method);
        if (message.id === undefined) continue;
        handle(message, reply);
      }
    });
  });
  const known = threads ?? [{ id: THREAD, cwd: CWD, status: { type: "idle" }, preview: SECRET_PREVIEW }];
  const missing = method => missingCode === -32601 ? rpcError(-32601, "Method not found")
    : rpcError(-32600, `Invalid request: unknown variant \`${method}\``);
  const handle = (message, reply) => {
    const { id, method, params = {} } = message;
    if (method === "initialize") return reply({ id, result: { userAgent, codexHome: "/x" } });
    if (method === "thread/loaded/list") return reply({ id, result: { data: loaded, nextCursor: null } });
    if (method === "thread/list") return reply({ id, result: { data: known, nextCursor: null } });
    if (method === "thread/queue/list") {
      if (!queueSupported) return reply({ id, error: missing(method) });
      return reply({ id, result: { data: state.queue.filter(q => q.threadId === params.threadId)
        .map(({ threadId, ...rest }) => rest), nextCursor: null } });
    }
    if (method === "thread/queue/add") {
      if (!queueSupported) return reply({ id, error: missing(method) });
      const item = { threadId: params.threadId, id: `qs_${state.queue.length + 1}`,
        clientUserMessageId: params.clientUserMessageId, input: params.input };
      state.queue.push(item);
      const { threadId, ...queuedSubmission } = item;
      return reply({ id, result: { queuedSubmission } });
    }
    return reply({ id, error: missing(method) });
  };
  server.calls = [];
  server.state = state;
  return new Promise(resolve => server.listen(socketPath, () => resolve({
    socketPath, server,
    async close() { for (const s of sockets) s.destroy();
      await new Promise(done => server.close(done)); rmSync(dir, { recursive: true, force: true }); },
  })));
}

const withDaemon = (options, fn) => async () => {
  const daemon = await startDaemon(options);
  const peer = openCodexAppServer({ socketPath: daemon.socketPath, timeoutMs: 1_000 });
  try { await fn(peer, daemon); } finally { await peer.close().catch(() => null); await daemon.close(); }
};

test("stable version comparison is numeric", () => {
  assert.equal(compareStableVersions("0.10.0", "0.9.99"), 1);
  assert.equal(compareStableVersions("0.152.1", "0.152.1"), 0);
  assert.equal(serverVersionOf(USER_AGENT), "0.152.1");
  assert.equal(isMethodMissing({ code: -32600, message: "Invalid request: unknown variant `x`" }), true);
  assert.equal(isMethodMissing({ code: -32603, message: "no rollout" }), false);
  assert.equal(safeReason({ code: "ECONNREFUSED" }), "transport_unavailable");
});

test("a supported probe reports the queue protocol and modes", withDaemon({}, async peer => {
  const probe = await probeCodexQueue(peer, { threadId: THREAD });
  assert.deepEqual(probe, { supported: true, serverVersion: "0.152.1", reasonCode: null,
    modes: ["livePush", "idleWake", "busyQueue"] });
}));

test("a probe rejects an app server without the queue method, below minimum, or mismatched",
  async () => {
    for (const [options, reasonCode] of [
      [{ queueSupported: false }, "protocol_mismatch"],
      [{ queueSupported: false, missingCode: -32600 }, "protocol_mismatch"],
      [{ userAgent: "acc/0.152.0 (Mac OS)" }, "below_minimum_version"],
      [{ userAgent: "acc/0.153.0-alpha.1 (Mac OS)" }, "prerelease_not_captured"],
    ]) {
      const daemon = await startDaemon(options);
      const peer = openCodexAppServer({ socketPath: daemon.socketPath, timeoutMs: 1_000 });
      try {
        assert.equal((await probeCodexQueue(peer, { threadId: THREAD })).reasonCode, reasonCode);
      } finally { await peer.close().catch(() => null); await daemon.close(); }
    }
  });

test("the exact thread is discovered from loaded state, never guessed",
  withDaemon({ loaded: ["other", THREAD], threads: [
    { id: "other", cwd: "/elsewhere", status: { type: "idle" } },
    { id: THREAD, cwd: CWD, status: { type: "active" } }] }, async peer => {
    assert.deepEqual(await locateCodexThread(peer, { threadId: THREAD, cwd: CWD }),
      { found: true, threadId: THREAD, status: "active" });
    assert.deepEqual(await locateCodexThread(peer, { threadId: "absent", cwd: CWD }),
      { found: false, reasonCode: "thread_not_loaded" });
    assert.deepEqual(await locateCodexThread(peer, { threadId: THREAD, cwd: "/nope" }),
      { found: false, reasonCode: "cwd_mismatch" });
  }));

test("a queue add carries the captured shape and a retry preserves the id",
  withDaemon({}, async (peer, daemon) => {
    const first = await addCodexQueueMessage(peer, { threadId: THREAD, messageId: "message_1",
      text: "untrusted body" });
    assert.deepEqual(first, { accepted: true, duplicate: false, queuedSubmissionId: "qs_1" });
    const add = daemon.server.state.queue[0];
    assert.deepEqual(add.input, [{ type: "text", text: "untrusted body" }]);
    assert.equal(add.clientUserMessageId, "message_1");
    const second = await addCodexQueueMessage(peer, { threadId: THREAD, messageId: "message_1",
      text: "untrusted body" });
    assert.deepEqual(second, { accepted: true, duplicate: true, queuedSubmissionId: "qs_1" });
    assert.equal(daemon.server.state.queue.length, 1);
    assert.equal(daemon.server.calls.some(m => /thread\/read|thread\/resume|turn\/start/.test(m)),
      false, "the client read transcript or steered a turn");
  }));

test("frames round-trip and a partial frame is buffered", () => {
  for (const length of [0, 125, 126, 70_000]) {
    const text = "x".repeat(length);
    assert.equal(decodeFrames(encodeFrame(text)).frames[0].payload.toString(), text);
  }
  assert.deepEqual(decodeFrames(encodeFrame("hi", { mask: false }).subarray(0, 2)).frames, []);
});
