import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bindNativeSession, offerMessage }
  from "../../packages/adapter-codex/src/native-delivery.mjs";
import { acceptKey, decodeFrames, encodeFrame } from "../../packages/adapter-codex/src/ws-json-rpc.mjs";

const THREAD = "01a063ed-a384-7fe2-b443-7fedf1593f6b";

// A fake daemon at the real control-socket path under a temp CODEX_HOME, so the
// adapter's own socket discovery and WebSocket client are exercised end to end.
async function daemon(t, { cwd }) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-nd-")));
  await mkdir(path.join(home, "app-server-control"), { recursive: true });
  const socketPath = path.join(home, "app-server-control", "app-server-control.sock");
  const server = http.createServer((request, response) => response.writeHead(404).end());
  const state = { queue: [] };
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
        if (message.id === undefined) continue;
        const reply = result => socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0",
          id: message.id, result }), { mask: false }));
        if (message.method === "initialize") reply({ userAgent: "acc/0.152.1 (Mac OS)" });
        else if (message.method === "thread/loaded/list") reply({ data: [THREAD], nextCursor: null });
        else if (message.method === "thread/list") reply({ data: [{ id: THREAD, cwd,
          status: { type: "idle" } }], nextCursor: null });
        else if (message.method === "thread/queue/list") reply({ data: state.queue, nextCursor: null });
        else if (message.method === "thread/queue/add") {
          const item = { id: `qs_${state.queue.length + 1}`,
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
  return { env: { CODEX_HOME: home }, state };
}

// The queue transport works against a real daemon and still does - that is
// worth holding on to, because it is not what failed. What failed is placing
// the session: native delivery needs codex --remote unix://, and in that mode
// the hook payload's cwd and the App Server's own thread record both name the
// daemon's directory rather than the session's. So the binding refuses even
// when the thread is right there, and nothing becomes addressable.
test("the queue still carries a labelled message, and the binding still refuses", async t => {
  const cwd = "/work/project";
  const place = await daemon(t, { cwd });
  const bound = await bindNativeSession({ event: { sessionId: THREAD, cwd },
    clientVersion: "0.152.1", env: place.env });
  assert.equal(bound.supported, false);
  assert.equal(bound.reasonCode, "workspace_identity_unavailable");
  assert.equal(bound.opaqueEndpointRef, null,
    "an endpoint ACC cannot place must not become addressable");

  const result = await offerMessage({ binding: { opaqueEndpointRef: THREAD,
    clientVersion: "0.152.1" }, message: { messageId: "message_1", kind: "question",
    subject: "Native?", body: "what is 3 + 3?" }, env: place.env });
  assert.deepEqual(result, { accepted: true, transport: "codex-app-server", clientVersion: "0.152.1" });
  assert.equal(place.state.queue.length, 1);
  assert.equal(place.state.queue[0].clientUserMessageId, "message_1");
  assert.match(place.state.queue[0].input[0].text, /untrusted peer content/);

  // A wrong thread stays durable.
  const wrong = await offerMessage({ binding: { opaqueEndpointRef: "absent",
    clientVersion: "0.152.1" }, message: { messageId: "m2", kind: "note", body: "x" },
  env: place.env });
  assert.equal(wrong.safeErrorCode, "recipient_unavailable");
});

test("with the daemon down the binding and offer fall back durably", async () => {
  const env = { CODEX_HOME: path.join(tmpdir(), "acc-codex-absent-daemon") };
  const bound = await bindNativeSession({ event: { sessionId: THREAD, cwd: "/x" },
    clientVersion: "0.152.1", env });
  assert.deepEqual([bound.supported, bound.reasonCode], [false, "handshake_failed"]);
  const offer = await offerMessage({ binding: { opaqueEndpointRef: THREAD,
    clientVersion: "0.152.1" }, message: { messageId: "m", kind: "note", body: "x" }, env });
  assert.equal(offer.safeErrorCode, "recipient_unavailable");
});
