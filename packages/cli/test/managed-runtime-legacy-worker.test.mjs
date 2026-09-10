import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeTest from "node:test";
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" ? "Unix process identity and signals" : false }, fn);
import { retireLegacyUpdateWorker } from "../src/managed-runtime/management-recovery.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";

async function fixture(t, name = "acc-update-worker.mjs") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-legacy-retire-")));
  const active = { version: "0.4.3", root: path.join(root, "generations/old") };
  await mkdir(path.join(active.root, "bin"), { recursive: true });
  await writeFile(path.join(active.root, "package.json"), JSON.stringify({ name: "agents-can-communicate", version: "0.4.3" }));
  await writeControl(root, { schemaVersion: 1, active, pending: null, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: root, targets: [], notice: null });
  const script = path.join(active.root, "bin", name);
  await writeFile(script, `import { withManagerLock } from ${JSON.stringify(new URL("../src/managed-runtime/mutex.mjs", import.meta.url).href)};
await withManagerLock(process.argv[2] + '/worker', async () => {
  console.log('ready'); await new Promise(() => { setInterval(() => {}, 10000); });
});\n`);
  const child = spawn(process.execPath, [script, root], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; await rm(root, { recursive: true, force: true }); });
  await once(child.stdout, "data");
  return { root, child, exit, active };
}

test("explicit update retires its verified legacy ACC helper and leaves lock reclamation to the mutex", async t => {
  const f = await fixture(t);
  assert.equal(await retireLegacyUpdateWorker(f.root), true);
  assert.deepEqual(await f.exit, [null, "SIGTERM"]);
  assert.equal((await readControl(f.root)).phase, "ready");
});

test("legacy recovery never interrupts integration writes or an unrelated process", async t => {
  const f = await fixture(t);
  await writeControl(f.root, { ...await readControl(f.root), phase: "activating" });
  assert.equal(await retireLegacyUpdateWorker(f.root), false);
  assert.equal(f.child.signalCode, null);
  const unrelated = await fixture(t, "unrelated.mjs");
  assert.equal(await retireLegacyUpdateWorker(unrelated.root), false);
  assert.equal(unrelated.child.signalCode, null);
});

test("a changed observed process identity cannot receive the termination signal", async t => {
  const f = await fixture(t);
  let reads = 0, signalled = false;
  assert.equal(await retireLegacyUpdateWorker(f.root, { inspect: async () => ({ uid: process.getuid(),
    start: new Date(Date.now() - (reads++ ? 60_000 : 0)).toString().slice(0, 24),
    command: `${process.execPath} ${path.join(f.active.root, "bin/acc-update-worker.mjs")} ${f.root}` }),
    signal: () => { signalled = true; } }), false);
  assert.equal(signalled, false);
});
