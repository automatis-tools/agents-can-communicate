import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { performUpdate } from "../src/managed-runtime/worker.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";

async function fixture(t, changes = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-worker-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = { version: "0.4.0", root: path.join(root, "generations", "old") };
  await mkdir(active.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending: null, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: root, targets: [], notice: null, ...changes });
  const calls = [];
  return { root, active, calls, ports: {
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
