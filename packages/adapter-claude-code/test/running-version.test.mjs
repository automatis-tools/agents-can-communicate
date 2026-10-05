import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeAdapter } from "../src/adapter.mjs";

// Claude Code updates itself in place, and Claude.app runs its own build: the
// `claude` on PATH answered 2.1.289 for a Claude.app session running 2.1.286
// and for a terminal session still running 2.1.284 (measured 2026-10-04). The
// session registry Claude Code writes for its own process names the build.
async function configWith(t, records) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-claude-version-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "sessions"));
  for (const [pid, record] of Object.entries(records)) {
    await writeFile(path.join(dir, "sessions", `${pid}.json`), JSON.stringify(record));
  }
  return dir;
}

const record = (pid, version) => ({ pid, sessionId: "75b0527d-29b1-4d48-8b0c-315aed1b361d",
  cwd: "/tmp", version, kind: "interactive", entrypoint: "claude-desktop",
  messagingSocketPath: `/tmp/cc-socks/${pid}.sock`, status: "idle" });

test("the running session's version comes from its own registry record",
  { skip: process.platform === "win32" }, async t => {
    const adapter = createClaudeCodeAdapter();
    const dir = await configWith(t, { 82557: record(82557, "2.1.286") });

    assert.equal(await adapter.clientVersionOf({ pid: 82557, entry: { comm: "claude" },
      env: { CLAUDE_CONFIG_DIR: dir } }), "2.1.286");
  });

test("no record, another pid's record or no version leaves the PATH probe to answer",
  { skip: process.platform === "win32" }, async t => {
    const adapter = createClaudeCodeAdapter();
    const dir = await configWith(t, { 100: record(200, "2.1.286"), 300: record(300, undefined),
      400: record(400, "latest") });
    const read = pid => adapter.clientVersionOf({ pid, entry: { comm: "claude" },
      env: { CLAUDE_CONFIG_DIR: dir } });

    assert.equal(await read(999), null);
    assert.equal(await read(100), null);
    assert.equal(await read(300), null);
    assert.equal(await read(400), null);
  });
