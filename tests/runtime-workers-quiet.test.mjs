import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeFixture } from "./helpers/fixture-cleanup.mjs";
import { runtimeWorkersQuiet } from "./helpers/runtime-workers.mjs";

// A fixture removed while ACC's detached worker still writes in it fails with
// ENOTEMPTY on POSIX: the documented-commands test did, under a loaded suite.
// Its cleanup waits for the worker; these hold the wait to what it promises.

async function dataHome(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-workers-quiet-")));
  t.after(() => removeFixture(root));
  return root;
}

test("the wait lasts while a worker's manager lock is held", async t => {
  const home = await dataHome(t);
  const lock = path.join(home, "acc", "runtime", "worker", "poller", "manager.lock");
  await mkdir(lock, { recursive: true });
  const released = new Promise(resolve => setTimeout(() => rm(lock, { recursive: true }).then(resolve), 600));
  const started = performance.now();
  await runtimeWorkersQuiet(home, { timeoutMs: 10_000 });
  const waited = performance.now() - started;
  await released;
  assert.equal(waited >= 550, true, "returned while the lock was still held");
});

test("the wait lasts while a process names the data home", { skip: process.platform === "win32"
  ? "Windows has no ps here; removal there is retried instead" : false }, async t => {
  const home = await dataHome(t);
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 700)", path.join(home, "acc", "runtime")],
    { stdio: "ignore" });
  const exited = new Promise(resolve => worker.on("exit", resolve));
  t.after(() => worker.exitCode === null && worker.kill());
  await new Promise(resolve => worker.once("spawn", resolve));
  const started = performance.now();
  await runtimeWorkersQuiet(home, { timeoutMs: 10_000 });
  // ps stops listing the process before this one hears of its exit, so the
  // time is what shows the wait.
  assert.equal(performance.now() - started >= 500, true, "returned while the process ran");
  await exited;
});

test("a quiet data home is not waited on", async t => {
  const home = await dataHome(t);
  const started = performance.now();
  await runtimeWorkersQuiet(home, { timeoutMs: 10_000 });
  assert.equal(performance.now() - started < 2_000, true);
});
