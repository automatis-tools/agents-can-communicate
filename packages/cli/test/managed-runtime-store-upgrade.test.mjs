import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openFilesystemStore, STORE_VERSION } from "@agents-can-communicate/storage-filesystem";

import { readManagedJson, writeControl, writeManagedJson } from "../src/managed-runtime/state.mjs";
import { migrateOlderStores, STORE_UPGRADE_MARKER } from "../src/managed-runtime/store-upgrade.mjs";
import { STORE_UPGRADE_RETRY_MS, storeUpgradeDue } from "../src/managed-runtime/schedule.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { exactMessage, EXACT_NOW as NOW } from "../../../tests/helpers/exact-transaction-contract.mjs";

/**
 * The new generation moves its data home's older stores itself (2026-10-06).
 *
 * #263 left contract 6 to 7 to an explicit command per workspace, and an
 * automatic update to a contract-7 runtime left every older workspace without
 * coordination, its remedy on a stderr line no client showed.
 */

async function fixture(t, { activeStoreVersion = STORE_VERSION } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-store-upgrade-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataHome = path.join(root, "data");
  const manager = path.join(dataHome, "acc", "runtime");
  const generation = path.join(manager, "generations", "new");
  await mkdir(generation, { recursive: true });
  const active = { root: generation, version: "0.10.0", storeVersion: activeStoreVersion };
  await writeControl(manager, { schemaVersion: 1, active, pending: null, phase: "ready", auto: false,
    pin: null, checkedAt: null, home: path.join(root, "home"), targets: [], notice: null });
  const store = async (workspaceId, storeVersion) => {
    const dir = path.join(dataHome, "acc", "workspaces", workspaceId);
    const opened = await openFilesystemStore({ root: dir, workspaceId, clock: createFakeClock(NOW),
      ids: createFakeIds() });
    await opened.transaction(tx => tx.put("message", `message_${workspaceId.slice(-4)}`,
      exactMessage({ workspaceId })), { kinds: ["message"] });
    const identity = path.join(dir, "protocol.json");
    await writeFile(identity, JSON.stringify({ ...JSON.parse(await readFile(identity, "utf8")), storeVersion }));
    return identity;
  };
  const versionOf = async identity => JSON.parse(await readFile(identity, "utf8")).storeVersion;
  const lease = async (pid, storeVersion) => {
    await mkdir(path.join(manager, "leases"), { recursive: true });
    await writeManagedJson(path.join(manager, "leases", "lease_a.json"), { schemaVersion: 1,
      token: "lease_a", pid, kind: "acc-hook", createdAt: NOW,
      runtime: { root: path.join(manager, "generations", "old"), version: "0.9.1", storeVersion } });
  };
  return { manager, generation, store, versionOf, lease };
}

test("every older store moves to this contract, and the pass is recorded complete", async t => {
  const f = await fixture(t);
  const older = await f.store("workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 6);
  const current = await f.store("workspace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", STORE_VERSION);

  const outcomes = await migrateOlderStores(f.manager);

  assert.deepEqual(outcomes, [{ workspaceId: "workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", state: "migrated" }]);
  assert.equal(await f.versionOf(older), STORE_VERSION);
  assert.equal(await f.versionOf(current), STORE_VERSION);
  const marker = await readManagedJson(path.join(f.manager, STORE_UPGRADE_MARKER));
  assert.equal(marker.activeRoot, f.generation);
  assert.equal(marker.complete, true);
  assert.equal(marker.pending, 0);
});

test("a live client of the older contract keeps its store as it is, and the pass stays open", async t => {
  const f = await fixture(t);
  const older = await f.store("workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 6);
  await f.lease(process.pid, 6);

  const outcomes = await migrateOlderStores(f.manager, { ignorePid: null });

  assert.deepEqual(outcomes.map(item => item.state), ["blocked"]);
  assert.equal(await f.versionOf(older), 6);
  const marker = await readManagedJson(path.join(f.manager, STORE_UPGRADE_MARKER));
  assert.equal(marker.complete, false);
  assert.equal(marker.pending, 1);
});

test("the activating process's own older lease does not hold the migration back", async t => {
  const f = await fixture(t);
  const older = await f.store("workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 6);
  await f.lease(process.pid, 6);

  await migrateOlderStores(f.manager, { ignorePid: process.pid });

  assert.equal(await f.versionOf(older), STORE_VERSION);
});

test("a generation of the older contract migrates nothing", async t => {
  const f = await fixture(t, { activeStoreVersion: 6 });
  const older = await f.store("workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 6);

  assert.deepEqual(await migrateOlderStores(f.manager), []);
  assert.equal(await f.versionOf(older), 6);
  // Recorded all the same, so the scheduler stops starting a pass for it.
  assert.equal((await readManagedJson(path.join(f.manager, STORE_UPGRADE_MARKER))).complete, true);
});

test("a store whose migration fails is reported, and the others still move", async t => {
  const f = await fixture(t);
  await f.store("workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 6);
  const second = await f.store("workspace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 6);
  const migrate = async options => {
    if (options.workspaceId.endsWith("a")) throw new Error("index could not publish");
    const { migrateFilesystemStore } = await import("@agents-can-communicate/storage-filesystem");
    return migrateFilesystemStore(options);
  };

  const outcomes = await migrateOlderStores(f.manager, { migrate });

  assert.deepEqual(outcomes.map(item => item.state).sort(), ["failed", "migrated"]);
  assert.equal(await f.versionOf(second), STORE_VERSION);
  assert.equal((await readManagedJson(path.join(f.manager, STORE_UPGRADE_MARKER))).complete, false);
});

test("the scheduler starts a pass for a new generation, and retries an open one after a minute", async t => {
  const f = await fixture(t);
  const control = { active: { root: f.generation, storeVersion: STORE_VERSION } };
  const marker = value => writeManagedJson(path.join(f.manager, STORE_UPGRADE_MARKER), value);
  const now = Date.parse(NOW);

  assert.equal(await storeUpgradeDue(f.manager, control, { now }), true, "no marker yet");
  await marker({ schemaVersion: 1, activeRoot: "/elsewhere", complete: true, pending: 0, attemptedAt: NOW });
  assert.equal(await storeUpgradeDue(f.manager, control, { now }), true, "another generation's marker");
  await marker({ schemaVersion: 1, activeRoot: f.generation, complete: true, pending: 0, attemptedAt: NOW });
  assert.equal(await storeUpgradeDue(f.manager, control, { now }), false, "done");
  await marker({ schemaVersion: 1, activeRoot: f.generation, complete: false, pending: 1, attemptedAt: NOW });
  assert.equal(await storeUpgradeDue(f.manager, control, { now }), false, "just tried");
  assert.equal(await storeUpgradeDue(f.manager, control, { now: now + STORE_UPGRADE_RETRY_MS }), true,
    "tried a minute ago");
});
