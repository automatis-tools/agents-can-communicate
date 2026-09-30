// A detached worker must outlive the command that started it, and on Windows it
// must not open a console window: without windowsHide every background update
// check flashed one. Both rules are checked here, the second statically over
// every detached spawn ACC ships, the first by starting one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const repo = path.resolve(import.meta.dirname, "..", "..");

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "test") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(full));
    else if (entry.name.endsWith(".mjs")) found.push(full);
  }
  return found;
}

test("every detached spawn ACC ships hides its console window", async () => {
  const offenders = [];
  for (const file of [...await sources(path.join(repo, "packages")), ...await sources(path.join(repo, "bin"))]) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\{[^{}]*detached: true[^{}]*\}/g)) {
      if (!/windowsHide: true/.test(match[0])) offenders.push(path.relative(repo, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("a detached, hidden worker outlives the process that started it", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "acc-detached-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "worker-ran");
  const worker = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok"), 700);`;
  const parent = `const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(worker)}],
      { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();`;
  const starter = spawn(process.execPath, ["-e", parent], { stdio: "ignore", windowsHide: true });
  await new Promise(resolve => starter.on("exit", resolve));
  assert.equal(existsSync(marker), false, "the worker was meant to still be waiting");
  for (let waited = 0; waited < 10_000 && !existsSync(marker); waited += 100) await delay(100);
  assert.equal(existsSync(marker), true);
});
