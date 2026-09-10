import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { activatePending, reclaimGenerations } from "../src/managed-runtime/activation.mjs";
import { stageOwnGeneration } from "../src/managed-runtime/generation.mjs";
import { stageNewerManagementRuntime } from "../src/managed-runtime/management-recovery.mjs";
import { writePin } from "../src/managed-runtime/pins.mjs";
import { attachStagingTemp, holdStagedGeneration, reapStagingHolds, releaseStagingHold }
  from "../src/managed-runtime/staging.mjs";
import { readControl, writeControl, writeManagedJson } from "../src/managed-runtime/state.mjs";

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
test("stageNewerManagementRuntime releases its staging hold once the attempt resolves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-recovery-release-"));
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

test("stageOwnGeneration's fast path (already matching, no rename) still returns a hold that protects the generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-faststage-"));
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

test("an abandoned staging temp is swept once its owner is confirmed dead", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-abandoned-"));
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

test("a live staging temp survives both reclaim and reap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-livetemp-"));
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

test("attachStagingTemp records the temp path onto a live hold", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-attach-live-"));
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
test("attachStagingTemp does nothing when the hold it would attach to is already gone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-attach-gone-"));
  const hold = await holdStagedGeneration({ root, generationRoot: path.join(root, "generations", "0.4.9-y"),
    pid: process.pid });
  await rm(hold, { force: true });
  await attachStagingTemp(hold, path.join(root, "generations", ".staging-def"));
  assert.deepEqual(await readdir(path.join(root, "staging")), []);
});

// A structural, source-text version of this test (comparing the index of
// the literal string "readdir(generations," against the reads of pins and
// staging) was tried in round 4 and removed in round 5: it does not pin the
// property it claims to. Reintroducing the exact reordering defect but
// spelling the reread as `readdir(path.join(root, "generations"), { ... })`
// instead of via the `generations` variable left the structural test
// passing - it only ever compared literal substrings, so a cosmetically
// different spelling of the identical bug was invisible to it - while this
// sampled test still caught the real, running defect. A test that a
// same-behavior rewording defeats is not proof of the invariant; only the
// test below, which drives the actual function against real concurrent
// writes, is. See the task report for the full account of why the
// deterministic route was tried and abandoned.
// This drives the real writer sequence (hold, then rename) concurrently with
// the real reclaimGenerations, jittering both sides across many trials so
// the two race genuinely rather than deterministically taking turns.
// Tuned empirically against a temporarily reverted copy of reclaimGenerations
// (candidates read moved back to the end): with no decoys and small jitter
// it essentially never landed the race, because withManagerLock's own
// acquisition (mkdir/write/sync/rename/sync/compact) dominates the
// wall-clock time and the gap between "holders read" and "candidates read"
// is under a millisecond on an otherwise-empty root. A batch of harmless
// decoy staging holds - each one real work for the staging-holds read to
// process - widens that gap to several milliseconds, and jittering the
// writer's start across that same span reliably lands the race.
//
// The per-trial failure rate against the reverted order has been measured
// three times, at three different trial counts, and disagreed each time:
// 16/60 (~27%), 10/70 (~14%), and most recently a dedicated 200-trial
// calibration run gave 6/200 (~3%) - the true rate is evidently low enough,
// and noisy enough at small sample sizes, that a trial count picked to be
// "comfortably high" against a 14% assumption (round 3's 70) is not safe:
// at the measured 3% rate, 70 trials only detects the defect ~88% of the
// time. TRIALS is set from that 200-trial measurement directly, not from an
// earlier, noisier one: at p=3%, 200 trials detects ~99.75% of the time
// (1 - 0.97^200); this file's own run below is additional, independent
// evidence on top of that calibration run, not a replacement for it.
test("a staging hold racing reclaim never loses, across many jittered interleavings", async () => {
  const TRIALS = 200;
  const DECOYS = 40;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let trial = 0; trial < TRIALS; trial++) {
    const root = await mkdtemp(path.join(tmpdir(), `acc-retain-race-${trial}-`));
    const activeRoot = path.join(root, "generations", "0.4.0-active");
    await mkdir(activeRoot, { recursive: true });
    await fixtureControl(root, { active: activeRoot });
    for (let decoy = 0; decoy < DECOYS; decoy++) {
      const decoyRoot = path.join(root, "generations", `decoy-${decoy}`);
      await mkdir(decoyRoot, { recursive: true });
      await holdStagedGeneration({ root, generationRoot: decoyRoot, pid: process.pid });
    }
    const targetName = "0.4.9-racing";
    const target = path.join(root, "generations", targetName);
    const writer = (async () => {
      await sleep(8 + Math.random() * 15);
      await holdStagedGeneration({ root, generationRoot: target, pid: process.pid });
      await mkdir(target, { recursive: true }); // stands in for stageOwnGeneration's rename
    })();
    const reclaim = reclaimGenerations({ root, active: null, pidIsAlive: () => true });
    await Promise.all([writer, reclaim]);
    const survivors = await readdir(path.join(root, "generations"));
    assert.ok(survivors.includes(targetName),
      `trial ${trial}: the racing generation was deleted while its hold was landing`);
  }
});
