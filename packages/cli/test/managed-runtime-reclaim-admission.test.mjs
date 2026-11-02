import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import { reclaimGenerations } from "../src/managed-runtime/activation.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { writeControl } from "../src/managed-runtime/state.mjs";
import { fixtureRoot } from "../../../tests/helpers/temp-workspace.mjs";

// Admission waits one second for the manager lock. Deleting an old generation
// took longer on a loaded Mac right after a background update, and every command
// in that window failed with "runtime unavailable; retry after the update".
test("admission succeeds while reclaim is still deleting an old generation", async t => {
  const root = await fixtureRoot(t, "acc-reclaim-admission-");
  const active = path.join(root, "generations", "0.4.1-active");
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(path.join(root, "generations", "0.4.0-old", "node_modules"), { recursive: true });
  await writeControl(root, { schemaVersion: 1, active: { version: "0.4.1", root: active }, pending: null,
    phase: "ready", auto: true, pin: null, checkedAt: null, home: root, targets: [], notice: null });

  const original = fs.rm;
  let deleting;
  const started = new Promise(resolve => { deleting = resolve; });
  t.after(() => { fs.rm = original; syncBuiltinESMExports(); });
  fs.rm = async (target, options) => {
    if (options?.recursive && path.basename(target).startsWith("0.4.0-old")) {
      deleting();
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    return original(target, options);
  };
  syncBuiltinESMExports();

  const reclaim = reclaimGenerations({ root, active, pidIsAlive: () => true });
  await started;
  const admission = await acquireRuntime(root, { pid: process.pid, kind: "cli" })
    .then(lease => ({ lease }), error => ({ error }));
  const reclaimed = await reclaim; // Always settle the pass before asserting.
  assert.equal(admission.error, undefined, `admission refused during reclaim: ${admission.error?.message}`);
  assert.equal(await fs.realpath(admission.lease.runtime.root), await fs.realpath(active));
  assert.deepEqual(reclaimed.removed, ["0.4.0-old"]);
  assert.deepEqual(await fs.readdir(path.join(root, "generations")), ["0.4.1-active"]);
  assert.deepEqual(await fs.readdir(path.join(root, "reclaimed")), []);
});

test("a reclaimed generation left by an interrupted pass is deleted by the next one", async t => {
  const root = await fixtureRoot(t, "acc-reclaim-leftover-");
  const active = path.join(root, "generations", "0.4.1-active");
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(path.join(root, "reclaimed", "0.3.9-left-behind", "node_modules"), { recursive: true });
  await writeControl(root, { schemaVersion: 1, active: { version: "0.4.1", root: active }, pending: null,
    phase: "ready", auto: true, pin: null, checkedAt: null, home: root, targets: [], notice: null });
  assert.deepEqual((await reclaimGenerations({ root, active, pidIsAlive: () => true })).removed, []);
  assert.deepEqual(await fs.readdir(path.join(root, "reclaimed")), []);
  assert.deepEqual(await fs.readdir(path.join(root, "generations")), ["0.4.1-active"]);
});

test("a generation whose rename is refused as busy is kept for a later pass", async t => {
  const root = await fixtureRoot(t, "acc-reclaim-busy-");
  const active = path.join(root, "generations", "0.4.1-active");
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(path.join(root, "generations", "0.4.0-busy"), { recursive: true });
  await writeControl(root, { schemaVersion: 1, active: { version: "0.4.1", root: active }, pending: null,
    phase: "ready", auto: true, pin: null, checkedAt: null, home: root, targets: [], notice: null });
  const original = fs.rename;
  t.after(() => { fs.rename = original; syncBuiltinESMExports(); });
  fs.rename = async (from, to) => {
    if (path.basename(from) === "0.4.0-busy") throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    return original(from, to);
  };
  syncBuiltinESMExports();
  assert.deepEqual((await reclaimGenerations({ root, active, pidIsAlive: () => true })).removed, []);
  assert.deepEqual((await fs.readdir(path.join(root, "generations"))).sort(), ["0.4.0-busy", "0.4.1-active"]);
});
