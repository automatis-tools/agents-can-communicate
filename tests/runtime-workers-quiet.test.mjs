import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

const posixOnly = { skip: process.platform === "win32"
  ? "Strict process inspection is POSIX-only; Windows verifier cleanup is unchanged" : false };

test("strict cleanup waits through lock release for the worker's final write", posixOnly, async t => {
  const home = await dataHome(t);
  const lock = path.join(home, "acc", "runtime", "worker", "manager.lock");
  await mkdir(lock, { recursive: true });
  const worker = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeFile } from "node:fs/promises";
    process.on("message", async () => {
      await writeFile(process.argv[1] + "/finished", "final write");
      process.disconnect();
    });
    process.send("ready");
  `, home], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = new Promise(resolve => worker.once("exit", resolve));
  t.after(async () => { if (worker.exitCode === null) worker.kill(); await exited; });
  await new Promise(resolve => worker.once("message", resolve));
  let removed = false;
  let cleanupFailure;
  const cleanup = runtimeWorkersQuiet(home, { strict: true, timeoutMs: 5_000 })
    .then(async () => {
      assert.equal(await readFile(path.join(home, "finished"), "utf8"), "final write");
      await rm(home, { recursive: true });
      removed = true;
    }).catch(error => { cleanupFailure = error; });
  // Observe both stages: a held lock, then the writer after releasing its lock.
  await pause(250);
  assert.equal(removed, false);
  await rm(lock, { recursive: true });
  await pause(250);
  assert.equal(removed, false, "deleted a root while its final writer was alive");
  worker.send("finish");
  await exited;
  await cleanup;
  assert.ifError(cleanupFailure);
  await assert.rejects(lstat(home), { code: "ENOENT" });
});

test("strict timeout retains a root whose manager lock is still held", posixOnly, async t => {
  const home = await dataHome(t);
  const lock = path.join(home, "acc", "runtime", "worker", "poller", "manager.lock");
  await mkdir(lock, { recursive: true });
  await assert.rejects(runtimeWorkersQuiet(home, { strict: true, timeoutMs: 100 })
    .then(() => rm(home, { recursive: true })), /timed out.*runtime workers/i);
  assert.equal((await lstat(lock)).isDirectory(), true);
});

test("strict inspection rejects a filesystem error instead of calling it unlocked", posixOnly, async t => {
  const home = await dataHome(t);
  await mkdir(path.join(home, "acc"));
  await writeFile(path.join(home, "acc", "runtime"), "not a directory");
  await assert.rejects(runtimeWorkersQuiet(home, { strict: true, timeoutMs: 100 }), /ENOTDIR/);
});

test("strict inspection rejects an unavailable process inspector", posixOnly, async t => {
  const home = await dataHome(t);
  const helper = new URL("./helpers/runtime-workers.mjs", import.meta.url).href;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { runtimeWorkersQuiet } from ${JSON.stringify(helper)};
    try {
      await runtimeWorkersQuiet(process.argv[1], { strict: true, timeoutMs: 100 });
      process.exitCode = 2;
    } catch (error) { console.log(error.message); }
  `, home], { env: { ...process.env, PATH: home }, timeout: 5_000 });
  assert.match(result.stdout, /ps.*ENOENT/);
});

test("a verification failure remains primary when cleanup inspection also fails", posixOnly, async t => {
  const home = await dataHome(t);
  const verifier = new URL("../scripts/verify-package.mjs", import.meta.url);
  const missing = path.join(home, "missing-archive.tgz");
  const failure = await promisify(execFile)(process.execPath, [fileURLToPath(verifier), missing], {
    env: { ...process.env, PATH: home, TMPDIR: home }, timeout: 5_000,
  }).then(() => assert.fail("verification unexpectedly succeeded"), error => error);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /Package cleanup failed; workspace retained at/);
  assert.match(failure.stderr, /Cannot inspect runtime workers.*ps.*ENOENT/);
  assert.match(failure.stderr.trim().split("\n").at(-1), /FAIL.*missing-archive\.tgz/);
  assert.doesNotMatch(failure.stdout, /PASS/);
  const retained = /workspace retained at (.+?): Cannot inspect/.exec(failure.stderr)[1];
  assert.equal(path.dirname(retained), home);
  assert.equal((await lstat(retained)).isDirectory(), true);
});
