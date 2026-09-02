// JSON-RPC over WebSocket on the Codex daemon control Unix socket, Node built-ins
// built-ins only. Observed on codex-cli 0.152.1: the app-server daemon's control
// socket answers an HTTP upgrade with 101 and then exchanges one JSON-RPC
// message per text frame. This peer speaks exactly that: masked client frames,
// unmasked server frames, ping/pong, and a close handshake.

import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE = Object.freeze({ continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 });

export function encodeFrame(payload, { opcode = OPCODE.text, mask = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const length = data.length;
  const header = [0x80 | opcode];
  if (length < 126) header.push((mask ? 0x80 : 0) | length);
  else if (length < 65_536) header.push((mask ? 0x80 : 0) | 126, length >> 8, length & 0xff);
  else {
    header.push((mask ? 0x80 : 0) | 127);
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(length));
    header.push(...big);
  }
  if (!mask) return Buffer.concat([Buffer.from(header), data]);
  const key = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = data[index] ^ key[index % 4];
  return Buffer.concat([Buffer.from(header), key, masked]);
}

// Returns { frames, rest }: every complete frame, and the bytes still waiting.
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const key = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (masked) for (let index = 0; index < length; index += 1) payload[index] ^= key[index % 4];
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function acceptKey(key) {
  return createHash("sha1").update(`${key}${GUID}`).digest("base64");
}

export function openWebSocketPeer({ socketPath, timeoutMs, path = "/", host = "localhost" }) {
  const notifications = [];
  const pending = new Map();
  const key = randomBytes(16).toString("base64");
  let nextId = 1;
  let closed = false;
  let handshaken = false;
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});

  const socket = net.createConnection(socketPath);
  socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n`
    + `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n`
    + "Sec-WebSocket-Version: 13\r\n\r\n"));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshaken) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString("latin1");
      buffer = buffer.subarray(end + 4);
      const accepted = /^HTTP\/1\.1 101/.test(head)
        && head.toLowerCase().includes(`sec-websocket-accept: ${acceptKey(key).toLowerCase()}`);
      if (!accepted) {
        fail(new Error("WebSocket handshake was rejected"));
        return;
      }
      handshaken = true;
      resolveReady();
    }
    const { frames, rest } = decodeFrames(buffer);
    buffer = Buffer.from(rest);
    for (const frame of frames) handleFrame(frame);
  });
  socket.on("error", (error) => fail(error));
  socket.on("close", () => fail(new Error("WebSocket peer closed")));

  function handleFrame(frame) {
    if (frame.opcode === OPCODE.ping) {
      if (!socket.destroyed) socket.write(encodeFrame(frame.payload, { opcode: OPCODE.pong }));
      return;
    }
    if (frame.opcode === OPCODE.close) {
      fail(new Error("WebSocket peer closed"));
      return;
    }
    if (frame.opcode !== OPCODE.text && frame.opcode !== OPCODE.continuation) return;
    fragments.push(frame.payload);
    if (!frame.fin) return;
    const text = Buffer.concat(fragments).toString("utf8");
    fragments = [];
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      fail(new Error("WebSocket peer wrote invalid JSON"));
      return;
    }
    if (!Object.hasOwn(message, "id") || message.id === null) {
      notifications.push(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(Object.assign(new Error(message.error.message ?? "JSON-RPC request failed"),
        { code: message.error.code ?? null }));
    } else {
      request.resolve(message.result);
    }
  }

  function fail(error) {
    if (closed) return;
    closed = true;
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    socket.destroy();
  }

  function send(message) {
    if (closed) throw Object.assign(new Error("WebSocket peer is closed"), { code: "EPIPE" });
    socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", ...message })));
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`),
          { code: "ETIMEDOUT" }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ready.then(() => send({ id, method, params })).catch((error) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  }

  function notify(method, params) {
    ready.then(() => send({ method, params })).catch(() => {});
  }

  async function close() {
    if (closed) return;
    try {
      if (handshaken) socket.write(encodeFrame(Buffer.alloc(0), { opcode: OPCODE.close }));
    } catch { /* already gone */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
    fail(new Error("WebSocket peer closed"));
  }

  return { request, notify, notifications, close, ready };
}
