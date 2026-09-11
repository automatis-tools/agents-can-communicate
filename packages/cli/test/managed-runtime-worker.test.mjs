import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { performUpdate } from "../src/managed-runtime/worker.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { withManagerLock } from "../src/managed-runtime/mutex.mjs";
import { scheduleWorker } from "../src/managed-runtime/schedule.mjs";

async function fixture(t, changes = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-worker-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = { version: "0.4.0", root: path.join(root, "generations", "old") };
  await mkdir(active.root, { recursive: true });
  // writeControl normalizes the runtime pointer (e.g. attaching storeVersion),
  // so the fixture tracks that normalized shape rather than its raw literal.
  const control = await writeControl(root, { schemaVersion: 1, active, pending: null, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: root, targets: [], notice: null, ...changes });
  const calls = [];
  return { root, active: control.active, calls, ports: {
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

test("a background poll releases the update lock while waiting for clients", async t => {
  const f = await fixture(t);
  const pending = { version: "0.4.1", root: path.join(f.root, "generations", "new") };
  const modules = path.join(pending.root, "node_modules", "@agents-can-communicate", "cli", "src", "managed-runtime");
  await mkdir(modules, { recursive: true });
  const marker = path.join(f.root, "prepared");
  // A file is visible before writeFile finishes; expose that publication window.
  await writeFile(path.join(modules, "refresh.mjs"), `import { writeFile } from 'node:fs/promises';
    export async function prepareRefresh() { await writeFile(${JSON.stringify(marker)}, '');
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(${JSON.stringify(marker)}, 'ready');
      return async () => ({ failed: [] }); }`);
  await writeControl(f.root, { ...await readControl(f.root), pending });
  await acquireRuntime(f.root, { kind: "acc-mcp" });
  const source = `import { runWorker } from ${JSON.stringify(new URL("../src/managed-runtime/worker.mjs", import.meta.url).href)};
    await runWorker(${JSON.stringify(f.root)}, { wait: true, env: {} });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await exited; });
  for (let attempt = 0; attempt < 100
    && await readFile(marker, "utf8").catch(() => null) !== "ready"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(marker, "utf8"), "ready");
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
