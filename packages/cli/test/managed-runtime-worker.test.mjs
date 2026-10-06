import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { performUpdate, runWorker } from "../src/managed-runtime/worker.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { withManagerLock } from "../src/managed-runtime/mutex.mjs";
import { scheduleWorker } from "../src/managed-runtime/schedule.mjs";
import { cleanupStack, removeFixture } from "../../../tests/helpers/fixture-cleanup.mjs";

// The worker scheduleWorker starts is detached: it outlives the call, with its
// working directory in the runtime root, and Windows refuses to remove that
// directory until it exits. This stand-in records its pid there, so a test that
// starts workers waits for each to exit before its fixture is removed.
const STUB_WORKER = 'import { appendFileSync } from "node:fs";\n'
  + 'appendFileSync("started-workers", `${process.pid}\\n`);\n';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function startedWorkersExited(root, count) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const pids = (await readFile(path.join(root, "started-workers"), "utf8").catch(() => ""))
      .split("\n").filter(Boolean).map(Number);
    if (pids.length >= count && !pids.some(alive)) return;
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} started workers to have run and exited; recorded ${JSON.stringify(pids)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const WORKER_ENV = { env: { ...process.env, ACC_NO_UPDATE_CHECK: "1" } };

async function fixture(t, changes = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-worker-")));
  const defer = cleanupStack(t);
  defer(() => removeFixture(root));
  const active = { version: "0.4.0", root: path.join(root, "generations", "old") };
  await mkdir(active.root, { recursive: true });
  // writeControl normalizes the runtime pointer (e.g. attaching storeVersion),
  // so the fixture tracks that normalized shape rather than its raw literal.
  const control = await writeControl(root, { schemaVersion: 1, active, pending: null, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: root, targets: [], notice: null, ...changes });
  const calls = [];
  return { root, defer, active: control.active, calls, ports: {
    env: {}, discover: async options => { calls.push(["discover", options.pin]); return { version: "0.4.1" }; },
    download: async () => { calls.push(["download"]); return { version: "0.4.1", root: path.join(root, "generations", "new") }; },
    activate: async () => { calls.push(["activate"]); return { activated: false, reason: "processes_active" }; },
  } };
}

test("opt-out, no-network override and daily throttle prevent automatic work", async t => {
  for (const changes of [{ auto: false }, { checkedAt: new Date().toISOString() }, {}]) {
    const f = await fixture(t, changes);
    const env = Object.keys(changes).length ? {} : { ACC_NO_UPDATE_CHECK: "1" };
    await performUpdate(f.root, { ...f.ports, env });
    assert.deepEqual(f.calls, []);
  }
});

test("check only discovers; automatic staging preserves active and honors an exact pin", async t => {
  const f = await fixture(t, { pin: "0.4.1" });
  const original = await readControl(f.root);
  const checked = await performUpdate(f.root, { ...f.ports, check: true });
  assert.equal(checked.newer, true);
  assert.deepEqual(f.calls, [["discover", "0.4.1"]]);
  assert.deepEqual(await readControl(f.root), original);
  f.calls.length = 0;
  await performUpdate(f.root, f.ports);
  assert.deepEqual(f.calls, [["discover", "0.4.1"], ["download"], ["activate"]]);
  const staged = await readControl(f.root);
  assert.deepEqual(staged.active, f.active);
  assert.equal(staged.pending.version, "0.4.1");
});

test("failed downloads keep the working runtime and concurrent opt-out prevents activation", async t => {
  const f = await fixture(t);
  await assert.rejects(performUpdate(f.root, { ...f.ports, download: async () => { throw new Error("broken archive"); } }), /broken archive/);
  assert.deepEqual((await readControl(f.root)).active, f.active);
  assert.equal((await readControl(f.root)).pending, null);
  const g = await fixture(t);
  await performUpdate(g.root, { ...g.ports, download: async () => {
    await writeControl(g.root, { ...await readControl(g.root), auto: false });
    return { version: "0.4.1", root: path.join(g.root, "generations", "new") };
  } });
  assert.equal(g.calls.some(([name]) => name === "activate"), false);
  assert.equal((await readControl(g.root)).pending, null);
});

test("a background poll releases the update lock while waiting for clients", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const pending = { version: "0.4.1", root: path.join(f.root, "generations", "new") };
  const modules = path.join(pending.root, "node_modules", "@agents-can-communicate", "cli", "src", "managed-runtime");
  await mkdir(modules, { recursive: true });
  await writeFile(path.join(modules, "refresh.mjs"),
    "export async function prepareRefresh() { return async () => ({ failed: [] }); }");
  await writeControl(f.root, { ...await readControl(f.root), pending });
  await acquireRuntime(f.root, { kind: "acc-mcp" });
  // Preparation finishes before the activation pass and its durable writes.
  // Observe the actual idle interval without shortening it or changing locks.
  const source = `import { runWorker } from ${JSON.stringify(new URL("../src/managed-runtime/worker.mjs", import.meta.url).href)};
    const sleep = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 60_000) process.send('waiting-for-clients');
      return sleep(callback, delay, ...args);
    };
    await runWorker(${JSON.stringify(f.root)}, { wait: true, env: {} });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await exited; });
  const [phase] = await Promise.race([
    once(child, "message", { signal: t.signal }),
    exited.then(([code, signal]) => { throw new Error(`worker exited before waiting (${code ?? signal}): ${stderr}`); }),
  ]);
  assert.equal(phase, "waiting-for-clients");
  assert.equal(await withManagerLock(path.join(f.root, "worker"), async () => "foreground admitted",
    { timeoutMs: 500 }), "foreground admitted");
  assert.equal(await scheduleWorker(f.root, await readControl(f.root), { env: {} }), false,
    "the existing idle poller prevents duplicate background workers");
});

test("an active maintenance job pauses ordinary update work without changing control", async t => {
  for (const status of ["waiting", "stopping", "refreshing", "restarting", "recovery"]) {
    const f = await fixture(t);
    await writeFile(path.join(f.root, "maintenance.json"), JSON.stringify({ schemaVersion: 1, status,
      id: "11111111-1111-1111-1111-111111111111", recipe: "fixture", deadline: Date.now() + 60_000,
      callerPid: process.pid, workerPid: process.pid, workerRoot: f.active.root, target: f.active, attempted: [],
      services: [{ adapterId: "codex", snapshot: { pid: process.pid } }] }));
    const original = await readControl(f.root);
    const result = await performUpdate(f.root, { ...f.ports, force: true });
    assert.equal(result.reason, "maintenance_pending");
    assert.deepEqual(await readControl(f.root), original);
    assert.deepEqual(f.calls, []);
  }
});

test("read-only update check reports an approved job without restarting its missing worker", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.active.root, "bin"), { recursive: true });
  await writeFile(path.join(f.active.root, "bin", "acc-maintenance-worker.mjs"), "process.exit(0);\n");
  const file = path.join(f.root, "maintenance.json");
  const bytes = JSON.stringify({ schemaVersion: 1, status: "recovery",
    id: "11111111-1111-1111-1111-111111111111", recipe: "fixture", deadline: Date.now() + 60_000,
    callerPid: process.pid, workerPid: null, workerRoot: f.active.root, target: f.active, attempted: ["codex"],
    services: [{ adapterId: "codex", snapshot: { pid: process.pid } }] });
  await writeFile(file, bytes);
  const result = await performUpdate(f.root, { ...f.ports, check: true });
  assert.equal(result.reason, "maintenance_pending");
  assert.equal(result.maintenance.status, "recovery");
  assert.equal(await readFile(file, "utf8"), bytes, "--check must leave the missing worker untouched");
  assert.deepEqual(f.calls, []);
});

// #208: an update is run by the older code, so the reclaim right after an
// activation is the older rule. The new generation's own worker reclaims on
// its first pass and on every later one, and records that it did.
test("the active generation's worker reclaims with its own rule and records it", async t => {
  const f = await fixture(t, { auto: false });
  const orphan = path.join(f.root, "generations", "orphan");
  await mkdir(orphan, { recursive: true });
  await runWorker(f.root, { env: {}, generationRoot: f.active.root });
  assert.deepEqual(await readdir(path.join(f.root, "generations")), ["old"]);
  const marker = JSON.parse(await readFile(path.join(f.root, "reclaim.json"), "utf8"));
  assert.equal(marker.activeRoot, f.active.root);
});

test("a worker that is not the active generation leaves reclaim to the one that is", async t => {
  const f = await fixture(t, { auto: false });
  const orphan = path.join(f.root, "generations", "orphan");
  await mkdir(orphan, { recursive: true });
  await runWorker(f.root, { env: {}, generationRoot: path.join(f.root, "generations", "orphan") });
  assert.deepEqual((await readdir(path.join(f.root, "generations"))).sort(), ["old", "orphan"]);
  await assert.rejects(readFile(path.join(f.root, "reclaim.json")), { code: "ENOENT" });
});

test("a generation that has not reclaimed yet gets a worker even with nothing to update", async t => {
  const f = await fixture(t, { auto: false, checkedAt: new Date().toISOString() });
  await mkdir(path.join(f.active.root, "bin"), { recursive: true });
  await writeFile(path.join(f.active.root, "bin", "acc-update-worker.mjs"), STUB_WORKER);
  f.defer(() => startedWorkersExited(f.root, 3));
  const control = await readControl(f.root);
  assert.equal(await scheduleWorker(f.root, control, WORKER_ENV), true);
  await writeFile(path.join(f.root, "reclaim.json"), JSON.stringify({ schemaVersion: 1,
    activeRoot: f.active.root }));
  assert.equal(await scheduleWorker(f.root, control, WORKER_ENV), true,
    "reclaimed, but this generation has not looked for older stores yet");
  await writeFile(path.join(f.root, "store-upgrade.json"), JSON.stringify({ schemaVersion: 1,
    activeRoot: f.active.root, complete: true }));
  assert.equal(await scheduleWorker(f.root, control, WORKER_ENV), false,
    "once this generation has reclaimed and moved its stores, nothing is due");
  await writeFile(path.join(f.root, "reclaim.json"), JSON.stringify({ schemaVersion: 1,
    activeRoot: path.join(f.root, "generations", "previous") }));
  assert.equal(await scheduleWorker(f.root, control, WORKER_ENV), true,
    "a marker left by an earlier generation is due again");
});

// Review of #228: a reclaim postponed by an unknown holder is not done; with
// automatic updates off, nothing else would ever try again.
test("a postponed reclaim is recorded as unfinished and is due again after an hour", async t => {
  const f = await fixture(t, { auto: false, checkedAt: new Date().toISOString() });
  await mkdir(path.join(f.root, "generations", "orphan"), { recursive: true });
  await mkdir(path.join(f.root, "leases"), { recursive: true });
  await writeFile(path.join(f.root, "leases", "broken.json"), "{ not json");
  await runWorker(f.root, { env: {}, generationRoot: f.active.root });
  assert.deepEqual((await readdir(path.join(f.root, "generations"))).sort(), ["old", "orphan"],
    "an unreadable lease is an unknown holder, so nothing is removed");
  const marker = JSON.parse(await readFile(path.join(f.root, "reclaim.json"), "utf8"));
  assert.equal(marker.activeRoot, f.active.root);
  assert.equal(marker.complete, false);
  await mkdir(path.join(f.active.root, "bin"), { recursive: true });
  await writeFile(path.join(f.active.root, "bin", "acc-update-worker.mjs"), STUB_WORKER);
  f.defer(() => startedWorkersExited(f.root, 1));
  const control = await readControl(f.root);
  const env = WORKER_ENV;
  assert.equal(await scheduleWorker(f.root, control, env), false, "not again right away");
  await writeFile(path.join(f.root, "reclaim.json"), JSON.stringify({ ...marker,
    attemptedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }));
  assert.equal(await scheduleWorker(f.root, control, env), true, "due again an hour later");
  await rm(path.join(f.root, "leases", "broken.json"));
  await runWorker(f.root, { env: {}, generationRoot: f.active.root });
  assert.deepEqual(await readdir(path.join(f.root, "generations")), ["old"]);
  assert.equal(JSON.parse(await readFile(path.join(f.root, "reclaim.json"), "utf8")).complete, true);
});

// Measured in the 0.8.5 upgrade preflight: `acc update` from 0.8.4 runs from
// the 0.8.4 generation and holds a lease on it while it activates 0.8.5 and
// runs 0.8.5's reclaim, so that pass cannot remove 0.8.4. Recorded as done, it
// left 0.8.4 in place until some later pass.
test("a reclaim held back by its own process's lease is unfinished and retried an hour later", async t => {
  const f = await fixture(t, { auto: false, checkedAt: new Date().toISOString() });
  await acquireRuntime(f.root, { kind: "acc" });
  const next = { version: "0.4.1", root: path.join(f.root, "generations", "new") };
  await mkdir(path.join(next.root, "bin"), { recursive: true });
  await writeFile(path.join(next.root, "bin", "acc-update-worker.mjs"), STUB_WORKER);
  f.defer(() => startedWorkersExited(f.root, 1));
  const control = await writeControl(f.root, { ...await readControl(f.root), active: next });
  await runWorker(f.root, { env: {}, generationRoot: control.active.root });
  assert.deepEqual((await readdir(path.join(f.root, "generations"))).sort(), ["new", "old"],
    "this process still runs from the old generation");
  const marker = JSON.parse(await readFile(path.join(f.root, "reclaim.json"), "utf8"));
  assert.equal(marker.activeRoot, control.active.root);
  assert.equal(marker.complete, false);
  const env = WORKER_ENV;
  assert.equal(await scheduleWorker(f.root, control, env), false,
    "commands right after an update start no worker");
  await writeFile(path.join(f.root, "reclaim.json"), JSON.stringify({ ...marker,
    attemptedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }));
  assert.equal(await scheduleWorker(f.root, control, env), true, "due again an hour later");
});

test("a reclaim that only live sessions or other processes held back is complete", async t => {
  const f = await fixture(t, { auto: false });
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"]);
  t.after(() => other.kill());
  await acquireRuntime(f.root, { pid: other.pid, kind: "mcp" });
  const next = { version: "0.4.1", root: path.join(f.root, "generations", "new") };
  await mkdir(next.root, { recursive: true });
  const control = await writeControl(f.root, { ...await readControl(f.root), active: next });
  await runWorker(f.root, { env: {}, generationRoot: control.active.root });
  assert.deepEqual((await readdir(path.join(f.root, "generations"))).sort(), ["new", "old"]);
  assert.equal(JSON.parse(await readFile(path.join(f.root, "reclaim.json"), "utf8")).complete, true);
});
