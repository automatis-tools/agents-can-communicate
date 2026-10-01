import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import { reclaimGenerations } from "../src/managed-runtime/activation.mjs";
import { holdStagedGeneration } from "../src/managed-runtime/staging.mjs";
import { writeControl } from "../src/managed-runtime/state.mjs";
import { fixtureRoot } from "../../../tests/helpers/temp-workspace.mjs";

// Moving candidate discovery after holder discovery must delete the racing
// generation and fail the survival assertion. All reads and durable writes are
// real; only the writer's timing is controlled at a directory-read boundary.
test("a generation published after the holder snapshot survives reclaim", async t => {
  const root = await fs.realpath(await fixtureRoot(t, "acc-retain-ordered-race-"));
  const generations = path.join(root, "generations");
  const staging = path.join(root, "staging");
  const active = path.join(generations, "active");
  const racing = path.join(generations, "racing");
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(path.join(generations, "orphan"));
  await writeControl(root, { schemaVersion: 1, active: { version: "0.0.0", root: active },
    pending: null, phase: "ready", auto: true, pin: null, checkedAt: null, home: root,
    targets: [], notice: null });
  await holdStagedGeneration({ root, generationRoot: active, pid: process.pid });

  const originalRead = fs.readdir;
  let reapingLiveHold = false;
  let published = false;
  fs.readdir = async (directory, ...args) => {
    const snapshot = await originalRead(directory, ...args);
    // The seed hold makes the real reaper check its owner before reclaim's
    // holder read. This identifies the boundary without counting fs calls.
    if (directory === staging && reapingLiveHold && !published) {
      await holdStagedGeneration({ root, generationRoot: racing, pid: process.pid });
      await fs.mkdir(racing);
      await fs.writeFile(path.join(racing, "payload.txt"), "live generation\n");
      published = true;
    }
    return snapshot;
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await reclaimGenerations({ root, pidIsAlive: () => {
      reapingLiveHold = true;
      return true;
    } });
  } finally {
    fs.readdir = originalRead;
    syncBuiltinESMExports();
  }

  assert.equal(published, true, "the writer must publish inside the holder snapshot boundary");
  const survivors = (await fs.readdir(generations)).sort();
  assert.ok(survivors.includes("racing"),
    "the live staging generation must survive reclamation");
  assert.deepEqual(survivors, ["active", "racing"], "the unreferenced orphan must actually be removed");
  assert.equal(await fs.readFile(path.join(racing, "payload.txt"), "utf8"), "live generation\n");
  assert.deepEqual(result.removed, ["orphan"], "the pass must still reclaim an actual orphan");
});
