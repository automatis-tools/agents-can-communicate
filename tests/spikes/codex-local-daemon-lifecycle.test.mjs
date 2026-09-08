import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { archive, selectLaunchHook }
  from "../../scripts/e2e/codex-local-daemon-actions.mjs";
import { createPtyDriver }
  from "../../scripts/e2e/codex-local-daemon-harness.mjs";

const execute = promisify(execFile);
const python = async () => (await execute("/usr/bin/env", ["python3", "-c",
  "import os; print(os.path.realpath(os.sys.executable))"])).stdout.trim();

test("loaded resumes require a fresh exact UserPromptSubmit while new launches require SessionStart", () => {
  const startedAt = "2026-09-08T00:00:00.000Z";
  const start = { event: "SessionStart", threadId: "old", at: "2026-09-08T00:00:01.000Z" };
  const prompt = { event: "UserPromptSubmit", threadId: "old", at: "2026-09-08T00:00:02.000Z" };
  assert.equal(selectLaunchHook([prompt], { startedAt, expectedThreadId: "old" }), prompt);
  assert.equal(selectLaunchHook([prompt], { startedAt }), null);
  assert.equal(selectLaunchHook([{ ...prompt, at: "2026-09-07T23:59:59.000Z" }],
    { startedAt, expectedThreadId: "old" }), null);
  assert.equal(selectLaunchHook([{ ...prompt, threadId: "wrong" }],
    { startedAt, expectedThreadId: "old" }), null);
  assert.equal(selectLaunchHook([{ ...start, threadId: "wrong" }, prompt],
    { startedAt, expectedThreadId: "old" }), null);
  assert.equal(selectLaunchHook([start], { startedAt }), start);
});

test("archive confirmation requires every observed popup literal", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-archive-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pty = createPtyDriver({ python: await python() });
  t.after(() => pty.close().catch(() => null));
  await pty.request({ action: "launch", role: "receiver-b1",
    argv: [await python(), "-c", "import sys,time; print('Archive this session? No, don\\'t archive', flush=True); time.sleep(30)"],
    cwd: root, env: process.env });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await pty.request({ action: "status", role: "receiver-b1" })).archiveConfirmation, false);
});

test("archive confirms the precise popup by selecting its second item", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-archive-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "archive-keys.bin");
  const program = [
    "import os,pathlib,select,sys,tty",
    "tty.setraw(sys.stdin.fileno())",
    "buf=b''",
    "while not buf.endswith(b'\\r'):",
    "    buf += os.read(sys.stdin.fileno(), 128)",
    "sys.stdout.write('Archive\\tthis\\n session?')",
    "sys.stdout.write(\"\\x1b[3;7HNo,  don't archive\")",
    "sys.stdout.write('\\x1b[5;2HYes, archive\\n and exit')",
    "sys.stdout.flush()",
    "keys=b''",
    "while len(keys) < 4:",
    "    ready, _, _ = select.select([sys.stdin.fileno()], [], [], 1)",
    "    if not ready: break",
    "    keys += os.read(sys.stdin.fileno(), 4 - len(keys))",
    `pathlib.Path(${JSON.stringify(marker)}).write_bytes(keys)`,
    "raise SystemExit(0)",
  ].join("\n");
  const pty = createPtyDriver({ python: await python() });
  t.after(() => pty.close().catch(() => null));
  await pty.request({ action: "launch", role: "receiver-b1",
    argv: [await python(), "-c", program], cwd: root, env: process.env });
  assert.equal((await archive({ pty, roles: { "receiver-b1": {} } })).exit, 0);
  assert.deepEqual(await readFile(marker), Buffer.from("\x1b[B\r"));
});
