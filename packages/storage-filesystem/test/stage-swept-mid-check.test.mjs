import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { publishAtomic } from "../src/atomic-json.mjs";
import { assertManagedDirectory, ensureManagedDirectory } from "../src/safe-directory.mjs";
import { storePaths } from "../src/store.mjs";

// CI on #217, ubuntu only: three first hook starts on one fresh store, and one
// failed with `ENOENT ... realpath '<store>/stage'`. One open held the writer
// mutex and swept `stage` - renamed it aside and recreated it - while another,
// still opening, checked `stage` without the mutex. Linux realpath fails on a
// name that is gone; Darwin answers with the directory's new name. Measured in
// node:24 on Linux with concurrent first opens: 11 failed runs in 4,000.
// Each seam below puts that rename in one window deterministically.

async function store(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-stage-window-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = storePaths(root);
  for (const name of ["tmp", "stage", "state"]) await mkdir(paths[name], { recursive: true });
  return { root, paths, aside: path.join(root, "stage.taken-aside") };
}

const once = operation => {
  let done = false;
  return async (...args) => {
    if (done) return;
    done = true;
    await operation(...args);
  };
};

test("a create-mode check recreates a directory renamed between its check and its resolution", async t => {
  const { root, paths, aside } = await store(t);
  const afterInspect = once(async current => {
    assert.equal(current, paths.stage);
    await rename(paths.stage, aside);
  });

  assert.equal(await ensureManagedDirectory(root, paths.stage, { afterInspect }), paths.stage);
  assert.equal((await lstat(paths.stage)).isDirectory(), true, "the name the caller uses next exists");
  assert.equal((await lstat(aside)).isDirectory(), true, "what was taken aside is left alone");
});

test("an assert-mode check never recreates a directory that went away", async t => {
  const { root, paths, aside } = await store(t);
  await assertManagedDirectory(root, paths.stage,
    { afterInspect: once(() => rename(paths.stage, aside)) }).catch(() => null);
  await assert.rejects(lstat(paths.stage), error => error.code === "ENOENT");
  const missing = path.join(root, "never-created");
  await assert.rejects(assertManagedDirectory(root, missing), error => error.code === "ENOENT");
  await assert.rejects(lstat(missing), error => error.code === "ENOENT");
});

// Containment is re-established on every attempt, never carried over.
test("a link swapped in during the window is refused", async t => {
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "acc-stage-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(outside, "stage"));
  // One target named like the segment, so only containment can refuse it.
  for (const target of [outside, path.join(outside, "stage")]) {
    const { root, paths, aside } = await store(t);
    const afterInspect = once(async () => {
      await rename(paths.stage, aside);
      await symlink(target, paths.stage);
    });
    await assert.rejects(ensureManagedDirectory(root, paths.stage, { afterInspect }),
      error => error.code === EXIT.DATA, target);
  }
});

test("a directory that keeps going away ends the check", { timeout: 10_000 }, async t => {
  const { root, paths } = await store(t);
  let taken = 0;
  const afterInspect = async current => {
    if (current !== paths.stage) return;
    taken += 1;
    await rename(paths.stage, path.join(root, `stage.taken-${taken}`));
  };

  await ensureManagedDirectory(root, paths.stage, { afterInspect }).catch(() => null);
  assert.ok(taken >= 2 && taken <= 10, `retried a bounded number of times, took ${taken}`);
});

test("an accepted stage follows the directory taken between its check and the move", async t => {
  const { root, paths, aside } = await store(t);

  assert.equal(await publishAtomic(path.join(root, "state", "record.json"), Buffer.from("{}\n"),
    { root, tmpDir: paths.tmp, stageDir: paths.stage,
      afterStageEnsured: once(() => rename(paths.stage, aside)) }), "published");
  assert.deepEqual(await readdir(path.join(root, "state")), ["record.json"]);
  assert.equal((await readdir(paths.stage)).length, 1);
});

test("an accepted stage taken away right after the move still publishes", async t => {
  const { root, paths, aside } = await store(t);

  assert.equal(await publishAtomic(path.join(root, "state", "record.json"), Buffer.from("{}\n"),
    { root, tmpDir: paths.tmp, stageDir: paths.stage,
      afterStageRenamed: once(() => rename(paths.stage, aside)) }), "published");
  assert.deepEqual(await readdir(path.join(root, "state")), ["record.json"]);
  assert.equal((await readdir(aside)).length, 1, "the entry went with the directory the sweep discards");
});

test("an accepted stage taken on every attempt ends the publication", { timeout: 10_000 }, async t => {
  const { root, paths } = await store(t);
  let taken = 0;
  const afterStageEnsured = async () => {
    taken += 1;
    await rename(paths.stage, path.join(root, `stage.taken-${taken}`));
  };

  await publishAtomic(path.join(root, "state", "record.json"), Buffer.from("{}\n"),
    { root, tmpDir: paths.tmp, stageDir: paths.stage, afterStageEnsured }).catch(() => null);
  assert.ok(taken >= 2 && taken <= 10, `retried a bounded number of times, took ${taken}`);
});
