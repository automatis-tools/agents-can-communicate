import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { inboxSocketIsSafe, readPeerKey, readSessionRecord, verifyInbox }
  from "../src/inbox-registry.mjs";

// What Claude Code 2.1.286 published on windows-latest (measure/windows-live):
// the session record names a named pipe in the session-local namespace, and a
// key file beside it, named by the pid and the SHA-256 of the lowercased pipe
// path, holds the token a peer authenticates with.
const PIPE = "\\\\.\\pipe\\LOCAL\\cc-msg-6a0c9aff38e833fc0a2331be49fcad43";
const LISTED = "LOCAL\\cc-msg-6a0c9aff38e833fc0a2331be49fcad43";
const PROC_START = "134352993201904476";
const TOKEN = "0123456789abcdef0123456789abcdef";
const keyName = (pid, pipe) => `${pid}.${createHash("sha256").update(pipe.toLowerCase()).digest("hex")}.key`;
const win32 = { platform: "win32", listPipes: async () => [LISTED] };

async function config(t, { record = {}, key = {} } = {}) {
  const configDir = await mkdtemp(path.join(tmpdir(), "acc-claude-win-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const sessions = path.join(configDir, "sessions");
  await mkdir(sessions);
  await writeFile(path.join(sessions, "1524.json"), JSON.stringify({ pid: 1524,
    sessionId: "93c83ef9-935f-4f9f-8fdc-456a9eec8da6", cwd: "C:\\Users\\Ann\\project",
    procStart: PROC_START, pidDomain: "win32:host", messagingSocketPath: PIPE, ...record }));
  await writeFile(path.join(sessions, keyName(1524, PIPE)), JSON.stringify({ peerToken: TOKEN,
    procStartFt: PROC_START, pidDomain: "win32:host", ...key }));
  return { configDir, sessions };
}

test("windows: the session record names a named pipe and the process start", async t => {
  const { configDir } = await config(t);
  assert.deepEqual(await readSessionRecord({ configDir, clientPid: 1524, platform: "win32" }), {
    pid: 1524, sessionId: "93c83ef9-935f-4f9f-8fdc-456a9eec8da6", messagingSocketPath: PIPE,
    cwd: "C:\\Users\\Ann\\project", procStart: PROC_START, pidDomain: "win32:host" });
});

test("windows: a record naming anything but a Claude inbox pipe is not read", async t => {
  for (const messagingSocketPath of ["/tmp/cc-socks/1524.sock", "\\\\.\\pipe\\other",
    "\\\\.\\pipe\\LOCAL\\cc-msg-6a0c9aff", "\\\\server\\pipe\\cc-msg-6a0c9aff38e833fc0a2331be49fcad43"]) {
    const { configDir } = await config(t, { record: { messagingSocketPath } });
    assert.equal(await readSessionRecord({ configDir, clientPid: 1524, platform: "win32" }), null,
      messagingSocketPath);
  }
});

test("windows: a pipe is an inbox while the machine lists it", async () => {
  assert.equal(await inboxSocketIsSafe(PIPE, win32), true);
  assert.equal(await inboxSocketIsSafe(PIPE, { platform: "win32",
    listPipes: async () => [LISTED.toLowerCase()] }), true, "pipe names are case-insensitive");
  assert.equal(await inboxSocketIsSafe(PIPE, { platform: "win32", listPipes: async () => [] }), false);
  assert.equal(await inboxSocketIsSafe("\\\\.\\pipe\\other", win32), false);
});

test("windows: the record has to name the pipe the hook was given", async t => {
  const { configDir } = await config(t);
  const sessionId = "93c83ef9-935f-4f9f-8fdc-456a9eec8da6";
  assert.equal(await verifyInbox({ configDir, clientPid: 1524, sessionId,
    socketPath: PIPE.replace("LOCAL", "local"), ...win32 }), null);
  assert.equal(await verifyInbox({ configDir, clientPid: 1524, sessionId: "another",
    socketPath: PIPE, ...win32 }), "native_session_unavailable");
  assert.equal(await verifyInbox({ configDir, clientPid: 1524, sessionId, socketPath: PIPE,
    platform: "win32", listPipes: async () => [] }), "native_endpoint_unavailable");
  const other = "\\\\.\\pipe\\LOCAL\\cc-msg-ffffffffffffffffffffffffffffffff";
  assert.equal(await verifyInbox({ configDir, clientPid: 1524, sessionId, socketPath: other,
    platform: "win32", listPipes: async () => [LISTED, "LOCAL\\cc-msg-ffffffffffffffffffffffffffffffff"] }),
  "native_session_unavailable");
});

test("windows: the peer key is the one Claude published for this pipe and this process", async t => {
  const { configDir } = await config(t);
  const record = await readSessionRecord({ configDir, clientPid: 1524, platform: "win32" });
  assert.equal(await readPeerKey({ configDir, record }), TOKEN);
});

test("windows: a key for another process start, another pipe or another shape is not used", async t => {
  for (const key of [{ procStartFt: "134352993201904000" }, { peerToken: "not-a-token" },
    { pidDomain: "win32:other-host" }]) {
    const { configDir } = await config(t, { key });
    const record = await readSessionRecord({ configDir, clientPid: 1524, platform: "win32" });
    assert.equal(await readPeerKey({ configDir, record }), null, JSON.stringify(key));
  }
  const { configDir, sessions } = await config(t);
  const record = await readSessionRecord({ configDir, clientPid: 1524, platform: "win32" });
  await rm(path.join(sessions, keyName(1524, PIPE)));
  await writeFile(path.join(sessions, keyName(1524, "\\\\.\\pipe\\LOCAL\\cc-msg-other")),
    JSON.stringify({ peerToken: TOKEN, procStartFt: PROC_START, pidDomain: "win32:host" }));
  assert.equal(await readPeerKey({ configDir, record }), null);
});

test("windows: a key reached through a link is not read", async t => {
  const { configDir, sessions } = await config(t);
  const record = await readSessionRecord({ configDir, clientPid: 1524, platform: "win32" });
  const real = path.join(configDir, "elsewhere.key");
  await writeFile(real, JSON.stringify({ peerToken: TOKEN, procStartFt: PROC_START, pidDomain: "win32:host" }));
  await rm(path.join(sessions, keyName(1524, PIPE)));
  try {
    await symlink(real, path.join(sessions, keyName(1524, PIPE)));
  } catch (error) {
    if (error.code === "EPERM") { t.skip("this account may not create symlinks"); return; }
    throw error;
  }
  assert.equal(await readPeerKey({ configDir, record }), null);
});
