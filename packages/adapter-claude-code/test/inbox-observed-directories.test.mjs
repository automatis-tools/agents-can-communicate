import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import nodeTest from "node:test";

import { createClaudeCodeAdapter } from "../src/adapter.mjs";
import { newEndpointId, writeInboxEndpoint } from "../src/inbox-endpoint.mjs";
import { observedInboxDirectories } from "../src/inbox-observed-directories.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

// Review of #217: the grant list came from the installer's environment alone,
// so a session started with its own absolute CLAUDE_CODE_TMPDIR or
// XDG_RUNTIME_DIR bound an inbox outside it, the Codex sandbox got EPERM, and
// doctor still said configured. The adapter also declares the directory of
// every inbox it has bound, read from its own endpoint records.

// A short root keeps a socket path under the 104-byte macOS limit.
function fixture(t) {
  const root = mkdtempSync("/tmp/acc-observed-");
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    rmSync(root, { recursive: true, force: true });
  });
  const stateRoot = path.join(root, "state");
  const records = workspace => path.join(stateRoot, "workspaces", workspace, "claude-inbox-endpoints");
  const listen = async socketPath => {
    mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    const server = net.createServer(() => {});
    servers.push(server);
    await new Promise(resolve => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
  };
  const place = (workspace, name, text) => {
    mkdirSync(records(workspace), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(records(workspace), name), text, { mode: 0o600 });
  };
  return { root, stateRoot, records, listen, place };
}

const record = socketPath => ({ schemaVersion: 1, endpointId: newEndpointId(), socketPath,
  configDir: "/home/me/.claude", clientPid: 4242, sessionId: "session-x", clientVersion: "2.1.283",
  protocolContract: "claude-code-inbox-socket-v1", leaseUntil: "2026-09-28T00:00:00.000Z",
  reception: "delivered" });
const name = () => `${newEndpointId()}.json`;

test("a session bound under its own CLAUDE_CODE_TMPDIR is covered", async t => {
  const f = fixture(t);
  const socketPath = path.join(f.root, "own-tmp", "cc-socks", "4242.sock");
  await f.listen(socketPath);
  // Written by the adapter's own writer, so the location read is the one written.
  await writeInboxEndpoint({ runtimeDir: path.join(f.stateRoot, "workspaces", "w1"),
    record: record(socketPath) });

  assert.deepEqual(observedInboxDirectories({ stateRoot: f.stateRoot }),
    [path.join(f.root, "own-tmp", "cc-socks")]);
  const declared = createClaudeCodeAdapter().inboundSockets({ env: {}, platform: "darwin",
    uid: 501, stateRoot: f.stateRoot });
  assert.ok(declared.includes(path.join(f.root, "own-tmp", "cc-socks")), declared.join(", "));
  assert.ok(declared.includes("/tmp/cc-socks"));
});

test("every workspace's records count, each directory once", t => {
  const f = fixture(t);
  f.place("w1", name(), JSON.stringify(record("/run/user/1000/cc-socks/1.sock")));
  f.place("w1", name(), JSON.stringify(record("/run/user/1000/cc-socks/2.sock")));
  f.place("w2", name(), JSON.stringify(record("/opt/tmp/cc-socks-1000/3.sock")));
  assert.deepEqual(observedInboxDirectories({ stateRoot: f.stateRoot }),
    ["/opt/tmp/cc-socks-1000", "/run/user/1000/cc-socks"]);
});

// A grant widens the Codex sandbox, so only what can be a Claude Code inbox -
// a directory named as Claude Code names it - is taken from a file on disk.
test("what cannot be a Claude Code inbox record adds nothing", t => {
  const f = fixture(t);
  f.place("w1", name(), "{ not json");
  f.place("w1", name(), JSON.stringify(record("relative/cc-socks/1.sock")));
  f.place("w1", name(), JSON.stringify(record("/home/me/.ssh/agent.sock")));
  f.place("w1", name(), JSON.stringify({ ...record("/a/cc-socks/1.sock"), socketPath: 7 }));
  f.place("w1", "notes.json", JSON.stringify(record("/b/cc-socks/1.sock")));
  f.place("w1", name(), JSON.stringify({ ...record("/c/cc-socks/1.sock"), padding: "x".repeat(9_000) }));
  f.place("w1", "elsewhere.txt", JSON.stringify(record("/d/cc-socks/1.sock")));
  symlinkSync(path.join(f.records("w1"), "elsewhere.txt"), path.join(f.records("w1"), name()));
  assert.deepEqual(observedInboxDirectories({ stateRoot: f.stateRoot }), []);
});

test("a record another user owns adds nothing", t => {
  const f = fixture(t);
  f.place("w1", name(), JSON.stringify(record("/e/cc-socks/1.sock")));
  assert.deepEqual(observedInboxDirectories({ stateRoot: f.stateRoot }), ["/e/cc-socks"]);
  assert.deepEqual(observedInboxDirectories({ stateRoot: f.stateRoot,
    uid: (process.getuid?.() ?? 0) + 1 }), []);
});

test("no readable state adds nothing and never throws", t => {
  const f = fixture(t);
  for (const stateRoot of [undefined, "", "relative/state", path.join(f.root, "missing")]) {
    assert.deepEqual(observedInboxDirectories({ stateRoot }), []);
  }
  mkdirSync(f.stateRoot, { recursive: true });
  writeFileSync(path.join(f.stateRoot, "workspaces"), "a file where a directory belongs");
  assert.deepEqual(observedInboxDirectories({ stateRoot: f.stateRoot }), []);
  assert.deepEqual(createClaudeCodeAdapter().inboundSockets({ env: {}, platform: "darwin",
    uid: 501, stateRoot: f.stateRoot }), ["/tmp/cc-socks", "/tmp/cc-socks-501"]);
});

// A relative root would be read against whatever directory the command runs in.
test("a relative state root is not read against the working directory", t => {
  const f = fixture(t);
  const relative = path.join(f.root, "rel", "workspaces", "w1", "claude-inbox-endpoints");
  mkdirSync(relative, { recursive: true });
  writeFileSync(path.join(relative, name()), JSON.stringify(record("/f/cc-socks/1.sock")), { mode: 0o600 });
  const before = process.cwd();
  process.chdir(f.root);
  try {
    assert.deepEqual(observedInboxDirectories({ stateRoot: "rel" }), []);
  } finally {
    process.chdir(before);
  }
});

// Review of #217: a count cap dropped whatever sorted past it, and doctor then
// called the profile configured. Every matching record and workspace is read.
test("a bound inbox past any record count is covered", t => {
  const f = fixture(t);
  for (let index = 0; index < 256; index += 1) {
    f.place("w1", `claude_inbox_${index.toString(16).padStart(32, "0")}.json`,
      JSON.stringify(record("/usual/cc-socks/1.sock")));
  }
  f.place("w1", `claude_inbox_${"f".repeat(32)}.json`, JSON.stringify(record("/late/cc-socks/1.sock")));
  assert.deepEqual(observedInboxDirectories({ stateRoot: f.stateRoot }),
    ["/late/cc-socks", "/usual/cc-socks"]);
});

test("a bound inbox past any workspace count is covered", t => {
  const f = fixture(t);
  for (let index = 0; index < 1_024; index += 1) {
    mkdirSync(path.join(f.stateRoot, "workspaces", `workspace_${index.toString(16).padStart(32, "0")}`),
      { recursive: true });
  }
  f.place(`workspace_${"f".repeat(32)}`, name(), JSON.stringify(record("/last/cc-socks/1.sock")));
  assert.deepEqual(observedInboxDirectories({ stateRoot: f.stateRoot }), ["/last/cc-socks"]);
});
