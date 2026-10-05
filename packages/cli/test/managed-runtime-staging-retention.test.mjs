import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { reclaimGenerations } from "../src/managed-runtime/activation.mjs";
import { stageOwnGeneration } from "../src/managed-runtime/generation.mjs";
import { stageNewerManagementRuntime } from "../src/managed-runtime/management-recovery.mjs";
import { attachStagingTemp, holdStagedGeneration, reapStagingHolds, releaseStagingHold }
  from "../src/managed-runtime/staging.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";
import { fixtureRoot } from "../../../tests/helpers/temp-workspace.mjs";

async function fixtureControl(root, { active, pending = null, phase = "ready" } = {}) {
  await writeControl(root, { schemaVersion: 1, active: { version: "0.0.0", root: active },
    pending: pending ? { version: "0.0.1", root: pending } : null, phase,
    auto: true, pin: null, checkedAt: null, home: root, targets: [], notice: null });
}

test("a generation held only by a live staging hold survives reclamation", async t => {
  const root = await fixtureRoot(t, "acc-retain-staginghold-");
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

test("a staging hold whose process is confirmed dead does not save its generation", async t => {
  const root = await fixtureRoot(t, "acc-retain-deadstaging-");
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

test("a staging hold that cannot be read is an unknown holder and reclaim removes nothing", async t => {
  const root = await fixtureRoot(t, "acc-retain-badstaging-");
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

test("an in-flight staging temp is never touched by reclaim", async t => {
  const root = await fixtureRoot(t, "acc-retain-stagingtemp-");
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

test("a generation staged but not yet published is not deleted out from under the process staging it", async t => {
  const root = await fixtureRoot(t, "acc-retain-realstaging-");
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
  // Once the caller (a real installer/updater) is done with this attempt -
  // published or abandoned - it releases the hold; nothing else protects an
  // abandoned candidate after that, so it becomes reclaimable again.
  await releaseStagingHold(staged.hold);
  const after = await reclaimGenerations({ root: managerRoot, active: null, pidIsAlive: () => true });
  assert.deepEqual(after.removed, [path.basename(staged.root)]);
});

// Round 3 added explicit release wiring at every real staging call site
// (installManaged, stageNewerManagementRuntime, downloadRelease/worker.mjs),
// but nothing exercised any of them: a caller silently forgetting to
// release would pass every other test in this file. This drives a real
// production call site - stageNewerManagementRuntime, the simplest of the
// four (no scheduleWorker, no apply callback) - through an actual staging,
// verification (a real spawned subprocess, matching verifyGeneration's own
// contract), and publish, and asserts the hold is gone afterward.
test("stageNewerManagementRuntime releases its staging hold once the attempt resolves", async t => {
  const root = await fixtureRoot(t, "acc-retain-recovery-release-");
  const managerRoot = path.join(root, "manager");
  const packageRoot = path.join(root, "source");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  const activeRoot = path.join(managerRoot, "generations", "0.4.0-active");
  await mkdir(activeRoot, { recursive: true });
  await writeControl(managerRoot, { schemaVersion: 1, active: { version: "0.4.0", root: activeRoot },
    pending: null, phase: "ready", auto: true, pin: null, checkedAt: null, home: root,
    targets: [], notice: null });
  const manifest = { name: "agents-can-communicate", version: "0.4.8", files: ["bin/"],
    bundleDependencies: [], accManagedUpdateProtocol: 2 };
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  // A real subprocess verifyGeneration actually spawns and checks the
  // output of, not a mock: `acc <root>/bin/acc.mjs version --json`.
  await writeFile(path.join(packageRoot, "bin", "acc.mjs"),
    "if (process.argv[2] === 'version' && process.argv[3] === '--json') "
    + "console.log(JSON.stringify({ data: { version: '0.4.8' } }));\n");
  const staged = await stageNewerManagementRuntime(managerRoot, { packageRoot, env: {} });
  assert.equal(staged, true);
  assert.equal((await readControl(managerRoot)).pending.version, "0.4.8");
  const stagingDir = path.join(managerRoot, "staging");
  assert.deepEqual(await readdir(stagingDir).catch(() => []), []);
});

test("stageOwnGeneration's fast path (already matching, no rename) still returns a hold that protects the generation", async t => {
  const root = await fixtureRoot(t, "acc-retain-faststage-");
  const managerRoot = path.join(root, "manager");
  const packageRoot = path.join(root, "source");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  const manifest = { name: "agents-can-communicate", version: "0.4.6", files: ["bin/"], bundleDependencies: [] };
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageRoot, "bin", "acc.mjs"), "console.log('fast');\n");
  const publishedRoot = path.join(managerRoot, "generations", "0.1.0-published");
  await mkdir(publishedRoot, { recursive: true });
  await fixtureControl(managerRoot, { active: publishedRoot });
  const first = await stageOwnGeneration({ packageRoot, managerRoot });
  await releaseStagingHold(first.hold);
  // Second call hits existingMatches and returns without ever renaming
  // anything; it must still have registered its own hold for the window
  // between that check and whatever the caller does next.
  const second = await stageOwnGeneration({ packageRoot, managerRoot });
  assert.equal(second.root, first.root);
  assert.equal(typeof second.hold, "string");
  assert.notEqual(second.hold, first.hold);
  const result = await reclaimGenerations({ root: managerRoot, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.equal((await readdir(path.join(managerRoot, "generations"))).includes(path.basename(second.root)), true);
});

test("an abandoned staging temp is swept once its owner is confirmed dead", async t => {
  const root = await fixtureRoot(t, "acc-retain-abandoned-");
  const activeRoot = path.join(root, "generations", "0.4.0-active");
  await mkdir(activeRoot, { recursive: true });
  await fixtureControl(root, { active: activeRoot });
  const generationsDir = path.join(root, "generations");
  const stagingTemp = path.join(generationsDir, ".staging-orphaned");
  await mkdir(stagingTemp, { recursive: true });
  await writeFile(path.join(stagingTemp, "partial.txt"), "crashed mid-write");
  const hold = await holdStagedGeneration({ root, generationRoot: path.join(generationsDir, "0.4.9-abandoned"),
    stagingRoot: stagingTemp, pid: 999999 });
  await reclaimGenerations({ root, active: null, pidIsAlive: () => false });
  // The generations sweep never touches a dot-prefixed entry, dead owner or
  // not; only reapStagingHolds's own link between a hold and its temp
  // recovers the space, and only once the owner is confirmed dead.
  await assert.rejects(readFile(path.join(stagingTemp, "partial.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(hold), { code: "ENOENT" });
});

test("a live staging temp survives both reclaim and reap", async t => {
  const root = await fixtureRoot(t, "acc-retain-livetemp-");
  const activeRoot = path.join(root, "generations", "0.4.0-active");
  await mkdir(activeRoot, { recursive: true });
  await fixtureControl(root, { active: activeRoot });
  const generationsDir = path.join(root, "generations");
  const stagingTemp = path.join(generationsDir, ".staging-inflight");
  await mkdir(stagingTemp, { recursive: true });
  await writeFile(path.join(stagingTemp, "partial.txt"), "still being written");
  const hold = await holdStagedGeneration({ root, generationRoot: path.join(generationsDir, "0.4.9-inflight"),
    stagingRoot: stagingTemp, pid: process.pid });
  await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  await reapStagingHolds({ root, pidIsAlive: () => true });
  assert.equal(await readFile(path.join(stagingTemp, "partial.txt"), "utf8"), "still being written");
  assert.equal(JSON.parse(await readFile(hold, "utf8")).stagingRoot, stagingTemp);
});

test("attachStagingTemp records the temp path onto a live hold", async t => {
  const root = await fixtureRoot(t, "acc-retain-attach-live-");
  const hold = await holdStagedGeneration({ root, generationRoot: path.join(root, "generations", "0.4.9-x"),
    pid: process.pid });
  const stagingTemp = path.join(root, "generations", ".staging-abc");
  await attachStagingTemp(hold, stagingTemp);
  assert.equal(JSON.parse(await readFile(hold, "utf8")).stagingRoot, stagingTemp);
});

// Round 4 (must fix 1): attachStagingTemp used to do an unguarded
// read-modify-write. If the hold vanished between holdStagedGeneration
// returning it and this call (readManagedJson returns undefined on ENOENT,
// not a throw), `{ ...undefined, stagingRoot }` wrote `{ stagingRoot }`
// alone - no schemaVersion, no generationRoot, no pid - which
// reclaimGenerations reads as a malformed hold forever and reapStagingHolds
// can never reap (no valid pid to confirm dead). No concurrent window needs
// manufacturing to prove the guard: attachStagingTemp takes the file path
// directly, so removing it first reproduces the exact precondition.
test("attachStagingTemp does nothing when the hold it would attach to is already gone", async t => {
  const root = await fixtureRoot(t, "acc-retain-attach-gone-");
  const hold = await holdStagedGeneration({ root, generationRoot: path.join(root, "generations", "0.4.9-y"),
    pid: process.pid });
  await rm(hold, { force: true });
  await attachStagingTemp(hold, path.join(root, "generations", ".staging-def"));
  assert.deepEqual(await readdir(path.join(root, "staging")), []);
});
