import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listActivationBlockers } from "../src/managed-runtime/activation.mjs";
import { stageOwnGeneration } from "../src/managed-runtime/generation.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { readControl, writeManagedJson } from "../src/managed-runtime/state.mjs";

async function fixture(t, manifestChanges = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "acc-legacy-contract-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "runtime"), source = path.join(directory, "source");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "agents-can-communicate", version: "0.5.3", accStoreVersion: 6,
    files: ["bin"], bundleDependencies: [], ...manifestChanges,
  }));
  await writeFile(path.join(source, "bin", "acc.mjs"), "export const version = '0.5.3';\n");
  const staged = await stageOwnGeneration({ packageRoot: source, managerRoot: root });
  const runtime = { version: staged.version, root: staged.root };
  const control = { schemaVersion: 1, active: runtime, pending: null, phase: "ready",
    auto: false, pin: null, checkedAt: null, home: directory, targets: [], notice: null };
  // The 0.4.4 updater publishes exactly this pointer shape when activating a
  // newer generation: the manifest declares a contract, but the pointer does not.
  await writeManagedJson(path.join(root, "control.json"), control);
  const leaseFile = path.join(root, "leases", "legacy.json");
  await mkdir(path.dirname(leaseFile));
  const lease = { schemaVersion: 1, token: "legacy", pid: process.pid,
    kind: "acc-claude-channel", runtime, createdAt: new Date().toISOString() };
  await writeManagedJson(leaseFile, lease);
  return { root, runtime, control, lease, leaseFile };
}

test("admission repairs a legacy pointer before a new process publishes its contract", async t => {
  for (const storeVersion of [undefined, null]) {
    const f = await fixture(t);
    await writeManagedJson(path.join(f.root, "control.json"),
      { ...f.control, active: { ...f.runtime, storeVersion } });
    const lease = await acquireRuntime(f.root, { kind: "acc-claude-channel" });
    assert.equal(lease.runtime.storeVersion, 6);
    const durable = JSON.parse(await readFile(path.join(f.root, "leases", `${lease.token}.json`)));
    assert.equal(durable.runtime.storeVersion, 6);
  }
});

test("an already-running legacy lease permits a compatible update without rewriting its record", async t => {
  const f = await fixture(t);
  const original = await readFile(f.leaseFile);
  assert.deepEqual(await listActivationBlockers(f.root, { incomingStoreVersion: 6 }), []);
  assert.deepEqual(await readFile(f.leaseFile), original);
  const incompatible = await listActivationBlockers(f.root, { incomingStoreVersion: 7 });
  assert.equal(incompatible.length, 1);
  assert.equal(incompatible[0].storeVersion, 6);
});

test("a legacy pending pointer is judged by its own verified generation", async t => {
  const f = await fixture(t);
  await writeManagedJson(path.join(f.root, "control.json"), { ...f.control, pending: f.runtime });
  const control = await readControl(f.root);
  assert.equal(control.pending.storeVersion, 6);
  assert.deepEqual(await listActivationBlockers(f.root,
    { incomingStoreVersion: control.pending.storeVersion }), []);
});

test("recovery never replaces an explicit conflicting lease contract", async t => {
  const f = await fixture(t);
  await writeManagedJson(f.leaseFile, { ...f.lease, runtime: { ...f.runtime, storeVersion: 7 } });
  const blockers = await listActivationBlockers(f.root, { incomingStoreVersion: 6 });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].storeVersion, 7);
});

test("changed generation bytes cannot supply a missing historical contract", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.runtime.root, "bin", "acc.mjs"), "export const version = 'changed';\n");
  const blockers = await listActivationBlockers(f.root, { incomingStoreVersion: 6 });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].storeVersion, null);
  assert.equal((await acquireRuntime(f.root)).runtime.storeVersion, null,
    "unverifiable metadata must remain unknown without blocking ordinary admission");
});

test("a copied manifest in an unverified directory cannot release a live hold", async t => {
  const f = await fixture(t);
  const renamed = path.join(f.root, "generations", "unverified");
  await rename(f.runtime.root, renamed);
  await writeManagedJson(f.leaseFile, { ...f.lease, runtime: { ...f.runtime, root: renamed } });
  const blockers = await listActivationBlockers(f.root, { incomingStoreVersion: 6 });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].storeVersion, null);
});

test("a generation without a valid declaration stays unknown", async t => {
  for (const accStoreVersion of [undefined, null, 0, "6", -1]) {
    const f = await fixture(t, { accStoreVersion });
    const blockers = await listActivationBlockers(f.root, { incomingStoreVersion: 6 });
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].storeVersion, null);
    assert.equal((await acquireRuntime(f.root)).runtime.storeVersion, null);
  }
});

test("a mismatched version cannot borrow another generation's contract", async t => {
  const f = await fixture(t);
  await writeManagedJson(f.leaseFile, { ...f.lease, runtime: { ...f.runtime, version: "0.4.4" } });
  const blockers = await listActivationBlockers(f.root, { incomingStoreVersion: 6 });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].storeVersion, null);
});
