import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ENTRY_KINDS } from "../src/managed-runtime/entry.mjs";
import { writeLaunchers } from "../src/managed-runtime/launchers.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..", "..");
// What a 0.7.x updater requires of a package it downloads: an entrypoint for
// each of its own entry kinds (packages/cli/src/managed-runtime/download.mjs).
const KINDS_0_7 = ["acc", "acc-hook", "acc-mcp", "acc-bootstrap", "acc-claude-channel",
  "acc-antigravity-relay"];

test("writing launchers removes the entry point of a retired kind", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "acc-retired-kinds-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "bin", "acc-claude-channel.mjs"), "// 0.7.x launcher\n", { mode: 0o700 });

  await writeLaunchers(root, repo);

  await assert.rejects(access(path.join(root, "bin", "acc-claude-channel.mjs")), { code: "ENOENT" });
  for (const kind of ENTRY_KINDS) await access(path.join(root, "bin", `${kind}.mjs`));
});

test("the package keeps an entrypoint for every kind a 0.7.x updater verifies", async () => {
  for (const kind of KINDS_0_7) {
    const module = await import(pathToFileURL(path.join(repo, "bin", "entrypoints", `${kind}.mjs`)).href);
    assert.equal(typeof module.main, "function", kind);
  }
});

function spawnStub(kind) {
  const entry = pathToFileURL(path.join(repo, "bin", "entrypoints", `${kind}.mjs`)).href;
  return spawn(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(entry)}); await m.main({});`], { stdio: "pipe" });
}

function runStub(kind, input) {
  const child = spawnStub(kind);
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stdin.end(input);
  return new Promise(resolve => child.on("close", code => resolve({ code, stdout })));
}

test("an old shim reaching the bootstrap stub runs the vendor command unchanged", async () => {
  const { code, stdout } = await runStub("acc-bootstrap", "");
  assert.equal(code, 1);
  assert.equal(stdout, "");
});

test("an old Channel config reaching the channel stub gets a complete server with no tools", async () => {
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map(line => JSON.stringify(line)).join("\n");
  const { code, stdout } = await runStub("acc-claude-channel", `${lines}\n`);
  assert.equal(code, 0);
  const answers = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(answers.map(answer => answer.id), [1, 2]);
  assert.equal(answers[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(answers[0].result.capabilities, { tools: {} });
  assert.deepEqual(answers[1].result, { tools: [] });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`the channel stub exits on ${signal} while Claude still holds its stdin open`, async t => {
    const child = spawnStub("acc-claude-channel");
    const closed = new Promise(resolve => child.on("close", () => resolve("exited")));
    t.after(() => { child.kill("SIGKILL"); });
    // The first answer proves main() is serving, so its signal handling is in place.
    const serving = new Promise(resolve => child.stdout.once("data", resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    await serving;

    child.kill(signal);

    let timer;
    const outcome = await Promise.race([closed,
      new Promise(resolve => { timer = setTimeout(resolve, 10_000, "still running"); })]);
    clearTimeout(timer);
    assert.equal(outcome, "exited");
  });
}
