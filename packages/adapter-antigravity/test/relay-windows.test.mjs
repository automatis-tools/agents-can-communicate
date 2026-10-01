import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { askRelay, isSocketSafe } from "../src/native-delivery.mjs";
import { createRelay } from "../src/relay.mjs";
import { PROTOCOL_CONTRACT, RELAY_MODES, listRegistrations, relayDir, validRegistration,
  writeRegistration } from "../src/relay-endpoint.mjs";

// Windows has no Unix socket a relay could listen on that Node can reach, so
// the relay listens on a named pipe whose name carries 128 random bits and is
// kept only in its private registration; libuv creates it as the first
// instance, so nothing can take the name before the relay.
const PIPE = `\\\\.\\pipe\\acc-relay-${"ab".repeat(16)}`;
const registration = socketPath => ({ schemaVersion: 1,
  endpointId: `antigravity_relay_${"c".repeat(32)}`, conversationId: "conversation-1", agyPid: 100,
  relayPid: 200, socketPath, nonce: "d".repeat(64), clientVersion: "1.2.7",
  protocolContract: PROTOCOL_CONTRACT, modes: [...RELAY_MODES],
  leaseUntil: new Date(Date.now() + 60_000).toISOString() });

test("windows: a relay registration names an ACC relay pipe", () => {
  assert.equal(validRegistration(registration(PIPE), { platform: "win32" }), true);
  for (const socketPath of ["/tmp/acc-ch-501/rabcdef012345.sock",
    "\\\\.\\pipe\\LOCAL\\cc-msg-6a0c9aff38e833fc0a2331be49fcad43", "\\\\.\\pipe\\acc-relay-short",
    "\\\\server\\pipe\\acc-relay-abababababababababababababababab"]) {
    assert.equal(validRegistration(registration(socketPath), { platform: "win32" }), false, socketPath);
  }
});

test("windows: a relay creates its pipe name, never a socket path", () => {
  const relay = createRelay({ runtimeDir: tmpdir(), conversationId: "conversation-1", agyPid: 100,
    clientVersion: "1.2.7", api: {}, isAlive: () => true, platform: "win32" });
  assert.match(relay.socketPath, /^\\\\\.\\pipe\\acc-relay-[0-9a-f]{32}$/);
});

test("windows: registrations are read where every file reports mode 0o666", async t => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "acc-relay-win-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await writeRegistration({ runtimeDir, record: registration(PIPE), platform: "win32" });
  const dir = relayDir(await (await import("node:fs/promises")).realpath(runtimeDir));
  await chmod(dir, 0o777);
  for (const name of await readdir(dir)) await chmod(path.join(dir, name), 0o666);
  const found = await listRegistrations({ runtimeDir, platform: "win32" });
  assert.equal(found.length, 1);
  assert.equal(found[0].socketPath, PIPE);
});

test("windows: a relay pipe counts while the machine lists it", async () => {
  const listed = async () => [`acc-relay-${"ab".repeat(16)}`];
  assert.equal(await isSocketSafe(PIPE, { platform: "win32", listPipes: listed }), true);
  assert.equal(await isSocketSafe(PIPE, { platform: "win32", listPipes: async () => [] }), false);
  assert.equal(await isSocketSafe("\\\\.\\pipe\\LOCAL\\cc-msg-6a0c9aff38e833fc0a2331be49fcad43",
    { platform: "win32", listPipes: async () => ["LOCAL\\cc-msg-6a0c9aff38e833fc0a2331be49fcad43"] }), false);
});

test("windows: a relay listens on its pipe and answers its own nonce", {
  skip: process.platform === "win32" ? false : "a named pipe exists only on Windows",
}, async t => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "acc-relay-win-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const relay = createRelay({ runtimeDir, conversationId: "conversation-1", agyPid: process.pid,
    clientVersion: "1.2.7", isAlive: () => true,
    api: { sendMessage: async () => ({ ok: true }), conversationMetadata: async () => ({ ok: true }) } });
  t.after(() => relay.close("test"));
  const { socketPath } = await relay.listen();
  assert.match(socketPath, /^\\\\\.\\pipe\\acc-relay-[0-9a-f]{32}$/);
  const [record] = await listRegistrations({ runtimeDir });
  assert.equal(await isSocketSafe(socketPath), true);
  const pong = await askRelay(socketPath, { nonce: record.nonce, ping: true }, 2_000);
  assert.equal(pong.accepted, true);
  const refused = await askRelay(socketPath, { nonce: "e".repeat(64), ping: true }, 2_000);
  assert.notEqual(refused.accepted, true);
});
