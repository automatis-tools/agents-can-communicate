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
