import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import nodeTest from "node:test";
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" ? "Unix process identity and signals" : false }, fn);
import { inspectWorker, retireLegacyUpdateWorker } from "../src/managed-runtime/management-recovery.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t, name = "acc-update-worker.mjs", prefix = "acc-legacy-retire-") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
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

// Sets environment variables for one check and restores them afterwards.
async function withEnv(values, check) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await check(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

// Positive control on the real ps in a zone nine hours from UTC.
test("retirement reads the real helper's start time in another local zone", async t => {
  const f = await fixture(t);
  assert.equal(await withEnv({ TZ: "Asia/Tokyo" }, () => retireLegacyUpdateWorker(f.root)), true);
  assert.deepEqual(await f.exit, [null, "SIGTERM"]);
});

// When daylight saving time ends, Toronto's 01:30 happens twice; ps without a UTC
// zone prints the same text for both (seen on 2026-11-01).
test("retirement accepts a helper that started in the repeated daylight-saving hour", async t => {
  const f = await fixture(t);
  const ownerFile = path.join(f.root, "worker", "manager.lock", "owner.json");
  await writeFile(ownerFile, JSON.stringify({ ...JSON.parse(await readFile(ownerFile, "utf8")),
    acquiredAt: "2026-11-01T06:30:05.000Z" }));
  const ps = async (file, args, options) => {
    const real = await execFileAsync(file, args, options);
    const start = options.env.TZ === "UTC0" ? "Sun Nov  1 06:30:00 2026" : "Sun Nov  1 01:30:00 2026";
    return { stdout: real.stdout.replace(/^(\s*\d+\s+).{24}/, `$1${start}`) };
  };
  const retired = await withEnv({ TZ: "America/Toronto" },
    () => retireLegacyUpdateWorker(f.root, { inspect: pid => inspectWorker(pid, { run: ps }) }));
  assert.equal(retired, true);
  assert.deepEqual(await f.exit, [null, "SIGTERM"]);
});

// LC_ALL=C escapes non-ASCII command text, and the helper is then not recognized.
test("retirement recognizes a helper under a non-ASCII managed root", async t => {
  const f = await fixture(t, undefined, "acc-legacy-retire-Ніка é-");
  const utf8 = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  assert.equal(await withEnv({ LC_ALL: utf8 }, () => retireLegacyUpdateWorker(f.root)), true);
  assert.deepEqual(await f.exit, [null, "SIGTERM"]);
});
