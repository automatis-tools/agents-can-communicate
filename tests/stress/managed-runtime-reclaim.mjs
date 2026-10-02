// Extended randomized stress; outside default discovery.
// Run explicitly: node --test tests/stress/managed-runtime-reclaim.mjs
// The deterministic default gate is managed-runtime-reclaim-race.test.mjs.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { reclaimGenerations } from "../../packages/cli/src/managed-runtime/activation.mjs";
import { holdStagedGeneration, releaseStagingHold } from "../../packages/cli/src/managed-runtime/staging.mjs";
import { writeControl } from "../../packages/cli/src/managed-runtime/state.mjs";

async function fixtureControl(root, { active, pending = null, phase = "ready" } = {}) {
  await writeControl(root, { schemaVersion: 1, active: { version: "0.0.0", root: active },
    pending: pending ? { version: "0.0.1", root: pending } : null, phase,
    auto: true, pin: null, checkedAt: null, home: root, targets: [], notice: null });
}

// Real durable holds widen the writer/reader race across 200 jittered trials.
// At a measured 3% hit rate, this rejects the candidates-last defect about
// 99.75% of the time. The default gate controls that interleaving directly.
test("a staging hold racing reclaim never loses, across many jittered interleavings", async t => {
  const TRIALS = 200;
  const DECOYS = 40;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // The decoys are the same in every trial, and building their holds is where
  // the time went: each is a durable write, 40 of them 0.3 s on macOS, and 200
  // trials of that ran past the five-minute test limit on windows-latest. They
  // are built once; each trial races on a fresh target and then removes it and
  // its hold, so every reclaim still reads all 40 decoys while the hold lands.
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activeRoot = path.join(root, "generations", "0.4.0-active");
  await mkdir(activeRoot, { recursive: true });
  await fixtureControl(root, { active: activeRoot });
  for (let decoy = 0; decoy < DECOYS; decoy++) {
    const decoyRoot = path.join(root, "generations", `decoy-${decoy}`);
    await mkdir(decoyRoot, { recursive: true });
    await holdStagedGeneration({ root, generationRoot: decoyRoot, pid: process.pid });
  }
  for (let trial = 0; trial < TRIALS; trial++) {
    const targetName = `0.4.9-racing-${trial}`;
    const target = path.join(root, "generations", targetName);
    let hold = null;
    const writer = (async () => {
      await sleep(8 + Math.random() * 15);
      hold = await holdStagedGeneration({ root, generationRoot: target, pid: process.pid });
      await mkdir(target, { recursive: true }); // stands in for stageOwnGeneration's rename
    })();
    const reclaim = reclaimGenerations({ root, active: null, pidIsAlive: () => true });
    await Promise.all([writer, reclaim]);
    const survivors = await readdir(path.join(root, "generations"));
    assert.ok(survivors.includes(targetName),
      `trial ${trial}: the racing generation was deleted while its hold was landing`);
    assert.equal(survivors.filter(name => name.startsWith("decoy-")).length, DECOYS,
      `trial ${trial}: a held decoy was deleted`);
    await releaseStagingHold(hold);
    await rm(target, { recursive: true, force: true });
  }
});
