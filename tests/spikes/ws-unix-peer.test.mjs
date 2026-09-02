import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptKey, decodeFrames, encodeFrame, openWebSocketPeer }
  from "../../scripts/spikes/ws-unix-peer.mjs";

// A fake app-server daemon: HTTP upgrade on a Unix socket, then one JSON-RPC
// message per text frame, exactly as codex-cli 0.152.1 answered.
function startFakeDaemon({ onMessage, accept = true, ping = false }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acc-ws-peer-"));
  const socketPath = path.join(dir, "control.sock");
  const server = http.createServer((request, response) => response.writeHead(404).end());
  const sockets = new Set();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    if (!accept) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
      + `Sec-WebSocket-Accept: ${acceptKey(request.headers["sec-websocket-key"])}\r\n\r\n`);
    if (ping) socket.write(encodeFrame(Buffer.from("hi"), { opcode: 9, mask: false }));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = Buffer.from(rest);
      for (const frame of frames) {
        if (frame.opcode === 8) { socket.end(); return; }
        if (frame.opcode === 10) { server.pongs = (server.pongs ?? 0) + 1; continue; }
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString("utf8"));
        const reply = (payload) => socket.write(encodeFrame(JSON.stringify(payload), { mask: false }));
        onMessage(message, reply, socket);
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({
    socketPath, server,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
      rmSync(dir, { recursive: true, force: true });
    },
  })));
}

test("frames round-trip through the encoder and decoder at every length class", () => {
  for (const length of [0, 5, 125, 126, 300, 65_535, 70_000]) {
    const text = "x".repeat(length);
    const masked = decodeFrames(encodeFrame(text));
    const plain = decodeFrames(encodeFrame(text, { mask: false }));
    assert.equal(masked.frames[0].payload.toString(), text);
    assert.equal(plain.frames[0].payload.toString(), text);
    assert.equal(masked.rest.length, 0);
  }
  const partial = encodeFrame("hello", { mask: false }).subarray(0, 3);
  assert.deepEqual(decodeFrames(partial).frames, []);
  assert.equal(decodeFrames(partial).rest.length, 3);
});

test("the peer upgrades, correlates responses, keeps notifications, and answers pings",
  async () => {
    const daemon = await startFakeDaemon({ ping: true, onMessage: (message, reply) => {
      if (message.method === "initialize") {
        reply({ method: "remoteControl/status/changed", params: { status: "disabled" } });
        reply({ id: message.id, result: { userAgent: "acc/0.152.1 (Mac OS)" } });
      } else if (message.method === "thread/queue/list") {
        reply({ id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    } });
    const peer = openWebSocketPeer({ socketPath: daemon.socketPath, timeoutMs: 500 });
    try {
      const initialized = await peer.request("initialize", { clientInfo: { name: "acc", version: "0" } });
      assert.deepEqual(initialized, { userAgent: "acc/0.152.1 (Mac OS)" });
      peer.notify("initialized", {});
      await assert.rejects(peer.request("thread/queue/list", { threadId: "t" }),
        (error) => error.code === -32601);
      assert.equal(peer.notifications[0].method, "remoteControl/status/changed");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(daemon.server.pongs, 1);
    } finally {
      await peer.close();
      await daemon.close();
    }
  });

test("a rejected upgrade, a silent server, and a missing socket fail closed", async () => {
  const rejected = await startFakeDaemon({ accept: false, onMessage: () => {} });
  const silent = await startFakeDaemon({ onMessage: () => {} });
  try {
    const noUpgrade = openWebSocketPeer({ socketPath: rejected.socketPath, timeoutMs: 500 });
    await assert.rejects(noUpgrade.request("initialize", {}), /handshake was rejected|closed/);
    const quiet = openWebSocketPeer({ socketPath: silent.socketPath, timeoutMs: 40 });
    await assert.rejects(quiet.request("initialize", {}), (error) => error.code === "ETIMEDOUT");
    await quiet.close();
    const missing = openWebSocketPeer({ socketPath: path.join(rejected.socketPath, "..", "none.sock"),
      timeoutMs: 500 });
    await assert.rejects(missing.request("initialize", {}), (error) => error.code === "ENOENT");
  } finally {
    await rejected.close();
    await silent.close();
  }
});
