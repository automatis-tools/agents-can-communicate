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

// The test holds what it waits on and lets go itself, so no clock decides the
// outcome: the wait must still be pending while the thing is held, and end once
// it is gone.
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
function watch(home) {
  const state = { settled: false };
  state.done = runtimeWorkersQuiet(home, { timeoutMs: 60_000 }).then(() => { state.settled = true; });
  return state;
}

test("the wait lasts while a worker's manager lock is held", async t => {
  const home = await dataHome(t);
  const lock = path.join(home, "acc", "runtime", "worker", "poller", "manager.lock");
  await mkdir(lock, { recursive: true });
  const wait = watch(home);
  await pause(600);
  assert.equal(wait.settled, false, "returned while the lock was still held");
  await rm(lock, { recursive: true });
  await wait.done;
});

test("the wait lasts while a process names the data home", { skip: process.platform === "win32"
  ? "Windows has no ps here; removal there is retried instead" : false }, async t => {
  const home = await dataHome(t);
  // Lives until its input closes, which only this test does.
  const worker = spawn(process.execPath, ["-e", "process.stdin.resume()", path.join(home, "acc", "runtime")],
    { stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => worker.exitCode === null && worker.kill());
  await new Promise(resolve => worker.once("spawn", resolve));
  const wait = watch(home);
  await pause(600);
  assert.equal(wait.settled, false, "returned while the process ran");
  const exited = new Promise(resolve => worker.once("exit", resolve));
  worker.stdin.end();
  await exited;
  await wait.done;
});

test("a quiet data home is not waited on", async t => {
  const home = await dataHome(t);
  const started = performance.now();
  await runtimeWorkersQuiet(home, { timeoutMs: 10_000 });
  assert.equal(performance.now() - started < 2_000, true);
});
