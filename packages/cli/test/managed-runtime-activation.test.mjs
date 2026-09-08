import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { activatePending, listNativeHolds } from "../src/managed-runtime/activation.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";

async function fixture(t) {
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-activation-")));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const root = path.join(dataHome, "acc", "runtime");
  const active = { version: "0.4.0", root: path.join(root, "generations", "old") };
  const pending = { version: "0.4.1", root: path.join(root, "generations", "new") };
  await mkdir(active.root, { recursive: true }); await mkdir(pending.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: path.join(dataHome, "home"), targets: [], notice: null });
  return { root, dataHome, active, pending };
}
async function binding(f, value) {
  const dir = path.join(f.dataHome, "acc", "workspaces", "project", "bindings");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "native.json"), JSON.stringify({ schemaVersion: 1,
    accSessionId: "session_native", generation: "gen_native", harnessSessionId: "native", ...value }));
}

test("native client holds survive finish and age, and unknown PID is never presumed dead", async t => {
  const f = await fixture(t);
  await binding(f, { clientPid: process.pid, closedAt: "2000-01-01T00:00:00Z" });
  assert.equal((await listNativeHolds(f.root)).length, 1);
  let applied = 0;
  const prepare = async () => async () => { applied++; return { failed: [] }; };
  assert.equal((await activatePending(f.root, { prepare })).activated, false);
  assert.equal(applied, 0);
  assert.deepEqual((await readControl(f.root)).active, f.active);
  await binding(f, {});
  assert.equal((await activatePending(f.root, { prepare, pidIsAlive: () => false })).activated, false);
  assert.equal(applied, 0);
});

test("an idle ACC process prevents activation; only confirmed death permits switching", async t => {
  const f = await fixture(t);
  await acquireRuntime(f.root, { kind: "acc-mcp" });
  let applied = 0;
  const prepare = async () => async () => { applied++; return { failed: [] }; };
  assert.equal((await activatePending(f.root, { prepare })).activated, false);
  assert.equal(applied, 0);
  const result = await activatePending(f.root, { prepare, pidIsAlive: () => false });
  assert.equal(result.activated, true);
  assert.equal(applied, 1);
  assert.deepEqual((await readControl(f.root)).active, f.pending);
});

test("partial integration refresh keeps admission closed and retry repairs forward", async t => {
  const f = await fixture(t);
  const marker = path.join(f.dataHome, "first-integration-written");
  const failed = await activatePending(f.root, { prepare: async () => async () => {
    assert.equal((await readControl(f.root)).phase, "activating");
    await assert.rejects(acquireRuntime(f.root), /lock|activation/);
    await writeFile(marker, "candidate");
    return { failed: [{ adapterId: "second", error: "write refused" }] };
  } });
  assert.equal(failed.activated, false);
  const partial = await readControl(f.root);
  assert.equal(partial.phase, "activating");
  assert.deepEqual(partial.active, f.active);
  await assert.rejects(acquireRuntime(f.root), /activation/);
  assert.equal(await readFile(marker, "utf8"), "candidate");
  const repaired = await activatePending(f.root, { prepare: async () => async () => ({ failed: [] }) });
  assert.equal(repaired.activated, true);
  assert.equal((await readControl(f.root)).phase, "ready");
  assert.deepEqual((await readControl(f.root)).active, f.pending);
});
