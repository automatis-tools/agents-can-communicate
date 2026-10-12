// Free-running stress; outside default discovery.
// Run explicitly: node --test tests/stress/ancestor-symlink-race.mjs
// The deterministic default gate is "an ancestor swapped for a symlink at any
// step of the walk" in packages/storage-filesystem/test/lock-changing-hands.test.mjs.
//
// Sixteen readers walk a three-level path while a churn loop swaps its first
// segment for a symlink to a decoy and back. Only an admitted redirect fails it,
// and the run asserts that it exercised the race: on a loaded runner the
// schedule can leave no walk inside a quiet window, and it then fails without
// having proven anything, which is why it does not gate a pull request (#250).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { assertManagedDirectory } from "../../packages/storage-filesystem/src/safe-directory.mjs";

test("an ancestor swapped for a symlink cannot serve another directory in the store",
  async t => {
    const root = await mkdtemp(path.join(tmpdir(), "acc-ancestor-race-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const depth = ["l1", "l2", "l3"];
    const asked = path.join(root, "target");
    const parked = path.join(root, "target.parked");
    const decoy = path.join(root, "decoy");
    for (const base of [asked, decoy]) await mkdir(path.join(base, ...depth), { recursive: true });
    const leaf = path.join(asked, ...depth);
    // The walk reports identity as bigint; so must the decoy, or no match is possible.
    const decoyLeaf = await stat(path.join(decoy, ...depth), { bigint: true });
    const turn = () => new Promise(resolve => { setImmediate(resolve); });
    // `admitted` counts a walk that fits between two flips. A fixed 2 ms quiet
    // window was shorter than one three-level walk on a loaded runner, so no
    // walk was ever admitted and the proof of exercise failed with nothing
    // wrong. The window is several walks as measured here, and doubles after a
    // window no walk fitted in: the load can rise after it was measured - four
    // copies of this file at once on windows-latest left 2 ms admitting none.
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) await assertManagedDirectory(root, leaf);
    let quietMs = Math.max(2, Math.ceil(((performance.now() - started) / 20) * 4));

    const counts = { admitted: 0, redirected: 0, absent: 0, escaped: 0, notReal: 0, other: 0 };
    let flips = 0;
    let churning = true;
    const churn = (async () => {
      while (churning) {
        const seen = counts.admitted;
        try {
          await rename(asked, parked);
          await symlink(decoy, asked);
          flips += 1;
          for (let i = 0; i < 6; i += 1) await turn();
          await unlink(asked);
          await rename(parked, asked);
          await new Promise(resolve => { setTimeout(resolve, quietMs); });
        } catch { /* losing the race against ourselves is expected */ }
        if (counts.admitted === seen) quietMs = Math.min(quietMs * 2, 250);
      }
    })();

    const deadline = Date.now() + 2_500;
    const reader = async () => {
      while (Date.now() < deadline) {
        try {
          const found = await assertManagedDirectory(root, leaf);
          if (found.stat.dev === decoyLeaf.dev && found.stat.ino === decoyLeaf.ino) {
            counts.redirected += 1;
          } else counts.admitted += 1;
        } catch (error) {
          const message = error.message ?? "";
          if (error.code === "ENOENT") counts.absent += 1;
          else if (/escapes the canonical store root/.test(message)) counts.escaped += 1;
          else if (/is not a real directory/.test(message)) counts.notReal += 1;
          else counts.other += 1;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: 16 }, reader));
    } finally {
      churning = false;
      await churn;
    }

    const report = JSON.stringify({ flips, quietMs, ...counts });
    assert.equal(counts.redirected, 0, `another directory in the store was served: ${report}`);
    assert.ok(flips > 0 && counts.admitted > 0 && counts.notReal > 0,
      `the race never ran, so nothing was proven: ${report}`);
  });
