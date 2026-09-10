import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { activatePending, reclaimGenerations } from "../src/managed-runtime/activation.mjs";
import { stageOwnGeneration } from "../src/managed-runtime/generation.mjs";
import { writePin } from "../src/managed-runtime/pins.mjs";
import { holdStagedGeneration } from "../src/managed-runtime/staging.mjs";
import { writeControl, writeManagedJson } from "../src/managed-runtime/state.mjs";

// Every scenario below runs against a real, written control.json: an absent
// one now postpones the whole pass (Finding 4), so a test that wants to
// prove something survives - or is genuinely removed - needs a real control
// to reach the code being tested at all.
async function fixtureControl(root, { active, pending = null, phase = "ready" } = {}) {
  await writeControl(root, { schemaVersion: 1, active: { version: "0.0.0", root: active },
    pending: pending ? { version: "0.0.1", root: pending } : null, phase,
    auto: true, pin: null, checkedAt: null, home: root, targets: [], notice: null });
}

async function writeLease(root, name, runtimeRoot) {
  const directory = path.join(root, "leases");
  await mkdir(directory, { recursive: true });
  await writeManagedJson(path.join(directory, `${name}.json`), { schemaVersion: 1, token: name,
    pid: process.pid, kind: "cli", runtime: { version: "0.4.0", root: runtimeRoot },
    createdAt: new Date().toISOString() });
}

test("an unreferenced generation is removed and a pinned one is kept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-"));
  for (const name of ["0.4.0-a", "0.4.2-b", "0.4.4-c"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.4-c") });
  await writePin({ root, harnessSessionId: "h1",
    runtimeRoot: path.join(root, "generations", "0.4.2-b"), version: "0.4.2",
    storeVersion: 6, clientPid: process.pid });
  await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.4-c"),
    pidIsAlive: () => true });
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(), ["0.4.2-b", "0.4.4-c"]);
});

test("a generation held only by a live pin survives reclamation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-livepin-"));
  for (const name of ["0.3.9-orphan", "0.4.0-pinned-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  await writePin({ root, harnessSessionId: "session-live",
    runtimeRoot: path.join(root, "generations", "0.4.0-pinned-only"),
    version: "0.4.0", storeVersion: 6, clientPid: process.pid });
  const result = await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.1-active"),
    pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.3.9-orphan"]);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-pinned-only", "0.4.1-active"]);
});

test("a pin whose client is confirmed dead does not save its generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-deadpin-"));
  for (const name of ["0.4.0-dead-pin-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  await writePin({ root, harnessSessionId: "session-dead",
    runtimeRoot: path.join(root, "generations", "0.4.0-dead-pin-only"),
    version: "0.4.0", storeVersion: 6, clientPid: 999999 });
  const result = await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.1-active"),
    pidIsAlive: () => false });
  assert.deepEqual(result.removed, ["0.4.0-dead-pin-only"]);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.1-active"]);
});

test("a pin that cannot be read is an unknown holder and reclaim removes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-badpin-"));
  await mkdir(path.join(root, "generations", "0.4.0-would-be-orphan"), { recursive: true });
  await mkdir(path.join(root, "generations", "0.4.1-active"), { recursive: true });
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  const pinsDir = path.join(root, "pins");
  await mkdir(pinsDir, { recursive: true });
  await writeFile(path.join(pinsDir, "corrupt.json"), "not json");
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-would-be-orphan", "0.4.1-active"]);
});

test("an unreadable lease is an unknown holder and reclaim removes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-badlease-"));
  await mkdir(path.join(root, "generations", "0.4.0-would-be-orphan"), { recursive: true });
  await mkdir(path.join(root, "generations", "0.4.1-active"), { recursive: true });
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  const leasesDir = path.join(root, "leases");
  await mkdir(leasesDir, { recursive: true });
  await writeFile(path.join(leasesDir, "broken.json"), "null");
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-would-be-orphan", "0.4.1-active"]);
});

test("control's own active and pending pointers protect their generations without an explicit active override", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-control-"));
  for (const name of ["0.3.0-orphan", "0.4.0-active-from-control", "0.4.1-pending-from-control"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.0-active-from-control"),
    pending: path.join(root, "generations", "0.4.1-pending-from-control"), phase: "activating" });
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.3.0-orphan"]);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-active-from-control", "0.4.1-pending-from-control"]);
});

test("a generation held only by a live runtime lease survives reclamation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-livelease-"));
  for (const name of ["0.3.9-orphan", "0.4.0-leased-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  await writeLease(root, "aaaa", path.join(root, "generations", "0.4.0-leased-only"));
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.3.9-orphan"]);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-leased-only", "0.4.1-active"]);
});

test("activatePending reclaims the superseded generation once the new one is active", async () => {
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-retain-wiring-")));
  const root = path.join(dataHome, "acc", "runtime");
  const active = { version: "0.4.0", root: path.join(root, "generations", "old-gen") };
  const pending = { version: "0.4.1", root: path.join(root, "generations", "new-gen") };
  await mkdir(active.root, { recursive: true });
  await mkdir(pending.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: dataHome, targets: [], notice: null });
  const result = await activatePending(root, { prepare: async () => async () => ({ failed: [] }) });
  assert.equal(result.activated, true);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(), ["new-gen"]);
});

test("a manager root with generations but no control.json is an unknown state and reclaim removes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-nocontrol-"));
  await mkdir(path.join(root, "generations", "0.4.0-orphan"), { recursive: true });
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.0-orphan"]);
});

test("a generation held only by a live staging hold survives reclamation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-staginghold-"));
  for (const name of ["0.3.9-orphan", "0.4.5-staged-only", "0.4.0-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.0-active") });
  await holdStagedGeneration({ root, generationRoot: path.join(root, "generations", "0.4.5-staged-only"),
    pid: process.pid });
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.3.9-orphan"]);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-active", "0.4.5-staged-only"]);
});

test("a staging hold whose process is confirmed dead does not save its generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-deadstaging-"));
  for (const name of ["0.4.5-abandoned", "0.4.0-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.0-active") });
  await holdStagedGeneration({ root, generationRoot: path.join(root, "generations", "0.4.5-abandoned"),
    pid: 999999 });
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => false });
  assert.deepEqual(result.removed, ["0.4.5-abandoned"]);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.0-active"]);
});

test("a staging hold that cannot be read is an unknown holder and reclaim removes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-badstaging-"));
  await mkdir(path.join(root, "generations", "0.4.0-would-be-orphan"), { recursive: true });
  await mkdir(path.join(root, "generations", "0.4.1-active"), { recursive: true });
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  const stagingDir = path.join(root, "staging");
  await mkdir(stagingDir, { recursive: true });
  await writeFile(path.join(stagingDir, "corrupt.json"), "not json");
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-would-be-orphan", "0.4.1-active"]);
});

test("an in-flight staging temp is never touched by reclaim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-stagingtemp-"));
  const activeRoot = path.join(root, "generations", "0.4.0-active");
  await mkdir(activeRoot, { recursive: true });
  const stagingTemp = path.join(root, "generations", ".staging-abc123");
  await mkdir(stagingTemp, { recursive: true });
  await writeFile(path.join(stagingTemp, "partial.txt"), "still being written");
  await fixtureControl(root, { active: activeRoot });
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.equal(await readFile(path.join(stagingTemp, "partial.txt"), "utf8"), "still being written");
});

test("a generation staged but not yet published is not deleted out from under the process staging it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-realstaging-"));
  const managerRoot = path.join(root, "manager");
  const packageRoot = path.join(root, "source");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  const manifest = { name: "agents-can-communicate", version: "0.4.5", files: ["bin/"], bundleDependencies: [] };
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageRoot, "bin", "acc.mjs"), "console.log('staged');\n");
  // An unrelated, already-published generation is what makes control.json
  // valid; the freshly staged one below is protected by nothing except the
  // hold stageOwnGeneration itself is required to write.
  const publishedRoot = path.join(managerRoot, "generations", "0.1.0-published");
  await mkdir(publishedRoot, { recursive: true });
  await fixtureControl(managerRoot, { active: publishedRoot });
  const staged = await stageOwnGeneration({ packageRoot, managerRoot });
  // This models the real window described in review: verifyGeneration may
  // still be running (or about to run) and the staging process has not yet
  // taken the manager lock to publish `staged` as pending or active.
  const result = await reclaimGenerations({ root: managerRoot, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.equal(await readFile(path.join(staged.root, "bin", "acc.mjs"), "utf8"), "console.log('staged');\n");
});
