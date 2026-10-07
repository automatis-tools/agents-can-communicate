import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { activatePending, listNativeHolds, reclaimGenerations, sweepStaleBindings } from "../src/managed-runtime/activation.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { writePin } from "../src/managed-runtime/pins.mjs";
import { prepareRefresh } from "../src/managed-runtime/refresh.mjs";
import { writeControl } from "../src/managed-runtime/state.mjs";

/**
 * A zombie has exited; only its parent has not collected it (#280).
 *
 * On 2026-10-06 the Codex daemon that `daemon stop` ended stayed a zombie under
 * Codex's own pid-update-loop, and the native bindings naming it kept 0.10.2
 * pending: `kill(pid, 0)` succeeds for a zombie.
 */

const alive = () => true;

async function fixture(t) {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "acc-zombie-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "acc", "runtime");
  const active = { version: "0.9.1", root: path.join(root, "generations", "old"), storeVersion: 6 };
  const pending = { version: "0.10.3", root: path.join(root, "generations", "new"), storeVersion: 7 };
  await mkdir(active.root, { recursive: true });
  await mkdir(pending.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: path.join(data, "home"), targets: [], notice: null });
  const bindings = path.join(data, "acc", "workspaces", "workspace_fixture", "bindings");
  await mkdir(bindings, { recursive: true });
  const bind = (name, clientPid) => writeFile(path.join(bindings, `${name}.json`), JSON.stringify({
    schemaVersion: 1, harnessSessionId: name, accSessionId: `session_${name}`,
    generation: `generation_${name}`, clientPid, storeVersion: 6 }));
  const remaining = async () => (await readdir(bindings)).sort();
  const generations = async () => (await readdir(path.join(root, "generations"))).sort();
  const leases = async () => (await readdir(path.join(root, "leases")).catch(() => [])).length;
  return { data, root, active, pending, bind, remaining, generations, leases };
}

const zombieIs = pid => async candidate => candidate === pid;

test("a binding whose client is a zombie does not block activation", async t => {
  const f = await fixture(t);
  await f.bind("daemon", 4242);

  const result = await activatePending(f.root, { pidIsAlive: alive, zombie: zombieIs(4242),
    startedAt: async () => null, prepare: async () => async () => ({ failed: [] }) });

  assert.equal(result.activated, true, JSON.stringify(result));
});

test("a runtime lease held by a zombie neither blocks activation nor keeps its generation", async t => {
  const f = await fixture(t);
  await acquireRuntime(f.root, { pid: 4242, kind: "acc-hook" });

  const result = await activatePending(f.root, { pidIsAlive: alive, zombie: zombieIs(4242),
    startedAt: async () => null, prepare: async () => async () => ({ failed: [] }) });

  assert.equal(result.activated, true, JSON.stringify(result));
  assert.deepEqual(await f.generations(), ["new"]);
});

test("a pin of a zombie client keeps no generation, a live client's pin still does", async t => {
  for (const [zombie, kept] of [[zombieIs(4242), ["new"]], [async () => null, ["new", "old"]]]) {
    const f = await fixture(t);
    await writeControl(f.root, { schemaVersion: 1, active: f.pending, pending: null, phase: "ready",
      auto: true, pin: null, checkedAt: null, home: path.dirname(f.root), targets: [], notice: null });
    await writePin({ root: f.root, harnessSessionId: "client", runtimeRoot: f.active.root,
      version: f.active.version, storeVersion: 6, clientPid: 4242 });

    await reclaimGenerations({ root: f.root, pidIsAlive: alive, zombie });

    assert.deepEqual(await f.generations(), kept);
  }
});

test("a binding of a live client, and one whose state cannot be read, still block", async t => {
  const f = await fixture(t);
  await f.bind("client", 4242);

  for (const zombie of [async () => false, async () => null]) {
    const result = await activatePending(f.root, { pidIsAlive: alive, zombie,
      startedAt: async () => null, prepare: async () => async () => ({ failed: [] }) });
    assert.equal(result.activated, false);
  }
});

// An older generation counts a zombie as a live client, so the pending
// generation's refresh removes those bindings for it.
test("the sweep removes a binding whose client is a zombie and keeps a live client's", async t => {
  const f = await fixture(t);
  await f.bind("daemon", 4242);
  await f.bind("client", 4343);

  const removed = await sweepStaleBindings(f.root, { pidIsAlive: alive, zombie: zombieIs(4242),
    startedAt: async () => null });

  assert.equal(removed, 1);
  assert.deepEqual(await f.remaining(), ["client.json"]);
});

// A child `sleep` whose parent shell `exec`s into another command that never
// collects it, as Codex's pid-update-loop left the daemon.
async function realZombie(t) {
  const parent = spawn("/bin/sh", ["-c", "sleep 0.1 & echo $!; exec sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => parent.kill("SIGKILL"));
  const pid = Number((await new Promise(resolve => parent.stdout.once("data", resolve))).toString().trim());
  await new Promise(resolve => setTimeout(resolve, 400));
  return pid;
}

test("a real zombie's binding is no hold", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await f.bind("daemon", await realZombie(t));

  assert.deepEqual(await listNativeHolds(f.root), []);
});

// An older generation lists its blockers right after the pending one's refresh
// returns, by a rule that counts a zombie as alive.
test("the pending generation's refresh removes a real zombie's binding and lease for an older activator",
  { skip: process.platform === "win32" }, async t => {
    const f = await fixture(t);
    const pid = await realZombie(t);
    await f.bind("daemon", pid);
    await f.bind("client", process.pid);
    await acquireRuntime(f.root, { pid, kind: "acc-hook" });
    const control = JSON.parse(await readFile(path.join(f.root, "control.json"), "utf8"));

    await prepareRefresh({ control, root: f.root, callerProtocol: 2,
      env: { HOME: path.join(f.data, "home"), ACC_DATA_HOME: f.data, PATH: "/usr/bin:/bin" } });

    assert.deepEqual(await f.remaining(), ["client.json"]);
    assert.equal(await f.leases(), 0);
  });
