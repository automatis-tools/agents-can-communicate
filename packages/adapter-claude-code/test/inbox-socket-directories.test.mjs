import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeCodeAdapter } from "../src/adapter.mjs";
import { inboxSocketDirectories } from "../src/inbox-socket-directories.mjs";

// Where Claude Code binds each session's inbox, read from the 2.1.283 binary:
// `${XDG_RUNTIME_DIR || CLAUDE_CODE_TMPDIR || "/tmp"}/cc-socks/<pid>.sock`, and
// `/tmp/cc-socks-<uid>/<pid>.sock` (Termux: `$PREFIX/tmp`) when the first path
// is longer than 103 bytes. A sandboxed sender is allowed these directories.

test("macOS with no override: the default and the long-path fallback", () => {
  assert.deepEqual(inboxSocketDirectories({ env: {}, platform: "darwin", uid: 501 }),
    ["/tmp/cc-socks", "/tmp/cc-socks-501"]);
});

test("XDG_RUNTIME_DIR wins over CLAUDE_CODE_TMPDIR, as in Claude Code", () => {
  assert.deepEqual(inboxSocketDirectories({ platform: "linux", uid: 1000,
    env: { XDG_RUNTIME_DIR: "/run/user/1000", CLAUDE_CODE_TMPDIR: "/home/me/tmp" } }),
  ["/run/user/1000/cc-socks", "/tmp/cc-socks", "/tmp/cc-socks-1000"]);
  assert.deepEqual(inboxSocketDirectories({ platform: "darwin", uid: 501,
    env: { CLAUDE_CODE_TMPDIR: "/Users/me/tmp" } }),
  ["/Users/me/tmp/cc-socks", "/tmp/cc-socks", "/tmp/cc-socks-501"]);
});

// A session started from another environment - a desktop terminal against an
// SSH login - binds under the other default, so Linux keeps both.
test("Linux keeps the per-user runtime default without XDG_RUNTIME_DIR", () => {
  assert.deepEqual(inboxSocketDirectories({ env: {}, platform: "linux-x64", uid: 1000 }),
    ["/tmp/cc-socks", "/run/user/1000/cc-socks", "/tmp/cc-socks-1000"]);
});

test("empty or relative overrides are not directories a grant can name", () => {
  assert.deepEqual(inboxSocketDirectories({ platform: "darwin", uid: 501,
    env: { XDG_RUNTIME_DIR: "", CLAUDE_CODE_TMPDIR: "relative/tmp" } }),
  ["/tmp/cc-socks", "/tmp/cc-socks-501"]);
});

test("Termux keeps its fallback under $PREFIX/tmp", () => {
  assert.deepEqual(inboxSocketDirectories({ platform: "android", uid: 10123,
    env: { TERMUX_VERSION: "0.118.0", PREFIX: "/data/data/com.termux/files/usr" } }),
  ["/tmp/cc-socks", "/data/data/com.termux/files/usr/tmp/cc-socks-10123"]);
});

// Native Windows serves the inbox on a named pipe, which no Unix socket grant covers.
test("Windows declares no socket directory", () => {
  assert.deepEqual(inboxSocketDirectories({ env: {}, platform: "win32", uid: 0 }), []);
});

test("the adapter declares these directories from the context it is given", () => {
  const adapter = createClaudeCodeAdapter();
  assert.deepEqual(adapter.inboundSockets({ env: { XDG_RUNTIME_DIR: "/run/user/7" },
    platform: "linux-arm64", uid: 7 }),
  ["/run/user/7/cc-socks", "/tmp/cc-socks", "/tmp/cc-socks-7"]);
});
