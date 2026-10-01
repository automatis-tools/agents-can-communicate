import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bindNativeSession, offerMessage, wakeText } from "../src/inbox-delivery.mjs";
import { ENDPOINTS_DIRECTORY, readInboxEndpoint } from "../src/inbox-endpoint.mjs";

// Claude Code on Windows (2.1.286, measured on windows-latest): the inbox is
// \\.\pipe\LOCAL\cc-msg-<32 hex>; a frame without an auth line, or with a wrong
// token, is dropped; after `{"type":"auth","token":<peer key>}` the frame runs a
// turn the session shows as another session's message.
const SESSION = "93c83ef9-935f-4f9f-8fdc-456a9eec8da6";
const PROC_START = "134352993201904476";
const TOKEN = "0123456789abcdef0123456789abcdef";
const CHILD_TOKEN = "ffffffffffffffffffffffffffffffff";

async function machine(t, { pipe = `\\\\.\\pipe\\LOCAL\\cc-msg-${randomBytes(16).toString("hex")}`,
  key = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-claude-winbind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, "claude");
  const runtimeDir = path.join(root, "runtime");
  const sessions = path.join(configDir, "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, "1524.json"), JSON.stringify({ pid: 1524, sessionId: SESSION,
    cwd: root, procStart: PROC_START, pidDomain: "win32:host", messagingSocketPath: pipe }));
  if (key) {
    const digest = createHash("sha256").update(pipe.toLowerCase()).digest("hex");
    await writeFile(path.join(sessions, `1524.${digest}.key`),
      JSON.stringify({ peerToken: TOKEN, procStartFt: PROC_START, pidDomain: "win32:host" }));
  }
  const listed = pipe.replace(/^\\\\\.\\pipe\\/, "");
  return { root, configDir, runtimeDir, pipe,
    system: { platform: "win32", listPipes: async () => [listed] },
    env: { CLAUDE_CODE_MESSAGING_SOCKET: pipe, CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_MESSAGING_TOKEN: CHILD_TOKEN } };
}

const bind = (place, extra = {}) => bindNativeSession({ event: { sessionId: SESSION, cwd: place.root },
  clientPid: 1524, clientVersion: "2.1.286", runtimeDir: place.runtimeDir, env: place.env,
  managedSettingsPath: path.join(place.root, "no-managed-settings.json"),
  readClientArgs: async () => ["claude.exe"], ...place.system, ...extra });

function recordingConnect() {
  const writes = [];
  const connect = target => {
    const socket = new EventEmitter();
    socket.target = target;
    socket.end = (data, done) => { writes.push({ target, data: String(data) }); done?.(); };
    socket.destroy = () => {};
    setImmediate(() => socket.emit("connect"));
    return socket;
  };
  return { writes, connect };
}

test("windows: a session binds to its pipe, and the record survives Windows file modes", async t => {
  const place = await machine(t);
  const bound = await bind(place);
  assert.equal(bound.supported, true, bound.reasonCode);
  // Windows reports every file and directory as 0o666 or 0o777: privacy there is
  // the profile's ACL, so the mode bits POSIX checks must not refuse the record.
  const dir = path.join(place.runtimeDir, ENDPOINTS_DIRECTORY);
  await chmod(dir, 0o777);
  for (const name of await readdir(dir)) await chmod(path.join(dir, name), 0o666);
  const endpoint = await readInboxEndpoint({ runtimeDir: place.runtimeDir,
    endpointId: bound.opaqueEndpointRef, ...place.system });
  assert.equal(endpoint?.socketPath, place.pipe);
});

test("windows: an offer authenticates with the peer key, then wakes", async t => {
  const place = await machine(t);
  const bound = await bind(place);
  const { writes, connect } = recordingConnect();
  const offered = await offerMessage({ binding: { ...bound, clientVersion: "2.1.286" },
    message: { messageId: "message_abc" }, runtimeDir: place.runtimeDir, connect, ...place.system });
  assert.equal(offered.accepted, true, offered.safeErrorCode);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, place.pipe);
  const lines = writes[0].data.split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(lines[0], { type: "auth", token: TOKEN },
    "the auth line carries the peer key, never the session's own messaging token");
  assert.deepEqual(lines[1], { type: "user", message: { role: "user", content: wakeText("message_abc") },
    msg_id: "acc-wake-message_abc" });
  assert.equal(writes[0].data.includes(CHILD_TOKEN), false);
});

test("windows: without a peer key nothing is sent and the message waits for the next turn", async t => {
  const place = await machine(t, { key: false });
  const bound = await bind(place);
  const { writes, connect } = recordingConnect();
  const offered = await offerMessage({ binding: { ...bound, clientVersion: "2.1.286" },
    message: { messageId: "message_abc" }, runtimeDir: place.runtimeDir, connect, ...place.system });
  assert.equal(offered.accepted, false);
  assert.equal(offered.safeErrorCode, "recipient_unavailable");
  assert.deepEqual(writes, []);
});

test("windows: a real pipe receives the auth line and the wake", {
  skip: process.platform === "win32" ? false : "a named pipe exists only on Windows",
}, async t => {
  const pipe = `\\\\.\\pipe\\LOCAL\\cc-msg-${randomBytes(16).toString("hex")}`;
  const received = [];
  const server = net.createServer(socket => {
    let text = "";
    socket.on("data", data => { text += data; });
    socket.on("end", () => received.push(text));
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const place = await machine(t, { pipe });
  const bound = await bindNativeSession({ event: { sessionId: SESSION, cwd: place.root }, clientPid: 1524,
    clientVersion: "2.1.286", runtimeDir: place.runtimeDir, env: place.env,
    managedSettingsPath: path.join(place.root, "none.json"), readClientArgs: async () => ["claude.exe"] });
  assert.equal(bound.supported, true, bound.reasonCode);
  const offered = await offerMessage({ binding: { ...bound, clientVersion: "2.1.286" },
    message: { messageId: "message_real" }, runtimeDir: place.runtimeDir });
  assert.equal(offered.accepted, true, offered.safeErrorCode);
  for (let waited = 0; waited < 2000 && received.length === 0; waited += 50) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const lines = received[0].split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.type), ["auth", "user"]);
  assert.equal(lines[0].token, TOKEN);
});
