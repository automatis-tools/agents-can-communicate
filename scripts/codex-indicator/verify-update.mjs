#!/usr/bin/env node
// Run against the compiled native CLI; no real update or credentials are used.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const binary = path.resolve(process.argv[2]);
const root = await mkdtemp(path.join(tmpdir(), "acc-codex-update-check-"));
try {
  const original = path.join(root, "vendor-codex");
  await writeFile(original, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.ACC_UPDATE_TEST_EXIT || 0));\n`, { mode: 0o755 });
  const env = { ...process.env, CODEX_HOME: root, CODEX_STATUS_PROVIDER_ORIGINAL_CLI: original };
  for (const args of [["update"], ["-c", "model=example", "update"], ["--config", 'note="update"', "update"]]) {
    const { stdout } = await exec(binary, args, { env });
    assert.deepEqual(JSON.parse(stdout), args);
  }
  await assert.rejects(exec(binary, ["update"], { env: { ...env, ACC_UPDATE_TEST_EXIT: "17" } }), { code: 17 });
  // A config value containing "update" must not redirect an unrelated command.
  const help = await exec(binary, ["-c", 'note="update"', "--help"], { env });
  assert.match(help.stdout, /Codex CLI/);
  console.log("Native update routing: plain/options-first/value argument, exit code, and unrelated help passed.");
} finally { await rm(root, { recursive: true, force: true }); }
