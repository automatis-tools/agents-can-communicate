import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sweepAcceptedStages } from "../src/stage-sweep.mjs";
import { storePaths } from "../src/store.mjs";

async function fixture(t, stages) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-sweep-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = storePaths(root);
  await mkdir(paths.stage, { recursive: true });
  await mkdir(paths.tmp, { recursive: true });
  for (let index = 0; index < stages; index += 1) {
    await writeFile(path.join(paths.stage, `${index}.published`), "{}\n");
  }
  return { root, paths };
}

const detachedIn = async root =>
  (await readdir(root)).filter(name => name.startsWith("stage.sweeping-"));

test("a sweep empties the stage directory", async t => {
  const { root, paths } = await fixture(t, 3);

  const result = await sweepAcceptedStages(paths, { root });

  assert.equal(result.swept, 3);
  assert.equal(result.remaining, false);
  assert.deepEqual(await readdir(paths.stage), []);
});

test("a sweep stops at its budget and reports the remainder", async t => {
  const { root, paths } = await fixture(t, 5);

  const result = await sweepAcceptedStages(paths, { root, limit: 2 });

  assert.equal(result.swept, 2);
  assert.equal(result.remaining, true);
  assert.deepEqual(await readdir(paths.stage), []);
  assert.equal((await detachedIn(root)).length, 1);
});

test("a later sweep adopts a directory an earlier one left behind", async t => {
  const { root, paths } = await fixture(t, 5);
  await sweepAcceptedStages(paths, { root, limit: 2 });
  await sweepAcceptedStages(paths, { root, limit: 2 });

  const last = await sweepAcceptedStages(paths, { root, limit: 2 });

  assert.equal(last.remaining, false);
  assert.deepEqual(await detachedIn(root), []);
});

test("a sweep leaves the store with an empty stage directory it can publish into", async t => {
  const { root, paths } = await fixture(t, 1);

  await sweepAcceptedStages(paths, { root });

  await writeFile(path.join(paths.stage, "next.published"), "{}\n");
  assert.deepEqual(await readdir(paths.stage), ["next.published"]);
});

test("an expired deadline stops the pass without throwing", async t => {
  const { root, paths } = await fixture(t, 4);

  const result = await sweepAcceptedStages(paths, { root, deadlineAt: Date.now() - 1 });

  assert.equal(result.swept, 0);
  assert.equal(result.remaining, true);
  assert.equal((await detachedIn(root)).length, 1);
});

test("an accepted stage an older version left in tmp is reclaimed", async t => {
  const { root, paths } = await fixture(t, 0);
  await writeFile(path.join(paths.tmp, "abc.published"), "{}\n");

  const result = await sweepAcceptedStages(paths, { root });

  assert.equal(result.swept, 1);
  assert.deepEqual(await readdir(paths.tmp), []);
});

test("a partial in tmp survives a sweep untouched", async t => {
  const { root, paths } = await fixture(t, 1);
  await writeFile(path.join(paths.tmp, "abc.published.1234.uuid.tmp"), "half\n");

  await sweepAcceptedStages(paths, { root });

  assert.deepEqual(await readdir(paths.tmp), ["abc.published.1234.uuid.tmp"]);
});

test("legacy reclamation shares the one budget", async t => {
  const { root, paths } = await fixture(t, 2);
  await writeFile(path.join(paths.tmp, "a.published"), "{}\n");
  await writeFile(path.join(paths.tmp, "b.published"), "{}\n");

  // Budget 3 buys two moves out of tmp and one removal, so one record left the
  // store and three entries remain in the detached directory for the next pass.
  const result = await sweepAcceptedStages(paths, { root, limit: 3 });

  assert.equal(result.swept, 1);
  assert.equal(result.remaining, true);
  assert.deepEqual(await readdir(paths.tmp), []);
  const [detached] = await detachedIn(root);
  assert.equal((await readdir(path.join(root, detached))).length, 3);
});

test("repeated passes drain a legacy accumulation completely", async t => {
  const { root, paths } = await fixture(t, 2);
  await writeFile(path.join(paths.tmp, "a.published"), "{}\n");
  await writeFile(path.join(paths.tmp, "b.published"), "{}\n");

  let guard = 0;
  let result = await sweepAcceptedStages(paths, { root, limit: 3 });
  while (result.remaining && guard < 10) {
    result = await sweepAcceptedStages(paths, { root, limit: 3 });
    guard += 1;
  }

  assert.equal(result.remaining, false);
  assert.deepEqual(await readdir(paths.stage), []);
  assert.deepEqual(await readdir(paths.tmp), []);
  assert.deepEqual(await detachedIn(root), []);
});
