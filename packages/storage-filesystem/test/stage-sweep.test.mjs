import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AccError, EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { sweepAcceptedStages, sweepIfDue } from "../src/stage-sweep.mjs";
import { openFilesystemStore, storePaths } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

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

test("a store with no stage directory yet is swept, not refused", async t => {
  const { root, paths } = await fixture(t, 0);
  // What an older version leaves behind: accepted stages in tmp and no stage
  // directory at all, because nothing has ever published into one.
  await rm(paths.stage, { recursive: true });
  await writeFile(path.join(paths.tmp, "abc.published"), "{}\n");

  const result = await sweepAcceptedStages(paths, { root });

  assert.equal(result.swept, 1);
  assert.deepEqual(await readdir(paths.tmp), []);
  assert.deepEqual(await readdir(paths.stage), []);
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

const clockAt = value => ({ now: () => value });

test("the first sweep is due and records when it ran", async t => {
  const { root, paths } = await fixture(t, 2);
  await mkdir(paths.locks, { recursive: true });

  const result = await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:00:00.000Z") });

  assert.equal(result.swept, 2);
  assert.deepEqual(await readdir(paths.stage), []);
});

test("a second sweep within the interval does nothing", async t => {
  const { root, paths } = await fixture(t, 2);
  await mkdir(paths.locks, { recursive: true });
  await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:00:00.000Z") });
  await writeFile(path.join(paths.stage, "later.published"), "{}\n");

  const result = await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T20:00:00.000Z") });

  assert.equal(result.swept, 0);
  assert.deepEqual(await readdir(paths.stage), ["later.published"]);
});

test("the writer mutex is taken only on the opens that actually sweep", async t => {
  const { root, paths } = await fixture(t, 2);
  await mkdir(paths.locks, { recursive: true });
  let locked = 0;
  const withLock = operation => { locked += 1; return operation(); };

  await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:00:00.000Z"), withLock });
  assert.equal(locked, 1, "the first, due pass locks");

  await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T20:00:00.000Z"), withLock });
  assert.equal(locked, 1, "a pass inside the interval must not pay for the lock");

  await sweepIfDue(paths, { root, clock: clockAt("2026-09-24T10:00:01.000Z"), withLock });
  assert.equal(locked, 2, "a pass after the interval locks again");
});

test("an expired deadline never fails the caller that opened the store", async t => {
  const { root, paths } = await fixture(t, 3);
  await mkdir(paths.locks, { recursive: true });
  let locked = 0;
  const withLock = operation => { locked += 1; return operation(); };

  // A due sweep whose budget is already gone. Writing the marker goes through
  // publishAtomic, which refuses an expired deadline by throwing, so this used
  // to raise out of the store open it runs inside.
  const result = await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:00:00.000Z"),
    deadlineAt: Date.now() - 1, withLock });

  assert.equal(result.remaining, true);
  assert.equal(locked, 0, "an exhausted budget should not even take the lock");
  assert.deepEqual(await readdir(paths.stage), ["0.published", "1.published", "2.published"]);
});

test("a pass that left work behind stays due instead of waiting a whole interval", async t => {
  const { root, paths } = await fixture(t, 5);
  await mkdir(paths.locks, { recursive: true });

  const first = await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:00:00.000Z"),
    limit: 2 });
  assert.equal(first.remaining, true);

  // One minute later, far inside the interval. Recording an unfinished pass as
  // done would park the rest for a day: a store holding 17,880 entries at 512
  // a pass would take weeks rather than a few opens.
  const second = await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:01:00.000Z"),
    limit: 2 });
  assert.equal(second.swept, 2, "the next open must carry on, not wait out the interval");

  let guard = 0;
  let result = second;
  while (result.remaining && guard < 10) {
    result = await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:02:00.000Z"),
      limit: 2 });
    guard += 1;
  }
  assert.equal(result.remaining, false);
  assert.deepEqual(await readdir(paths.stage), []);
  assert.deepEqual(await detachedIn(root), []);
});

test("a deadline that expires after the due check never reaches the caller", async t => {
  const { root, paths } = await fixture(t, 3);
  await mkdir(paths.locks, { recursive: true });
  // The budget is alive when sweepIfDue checks it and gone by the time the lock
  // is granted, which is what the mutex reports by refusing with CONFLICT.
  const withLock = () => {
    throw new AccError(EXIT.CONFLICT, "operation deadline expired before publication", {});
  };

  const result = await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:00:00.000Z"),
    deadlineAt: Date.now() + 60_000, withLock });

  assert.equal(result.swept, 0);
  assert.equal(result.remaining, true);
});

test("a real store fault still reaches the caller", async t => {
  const { root, paths } = await fixture(t, 3);
  await mkdir(paths.locks, { recursive: true });
  const withLock = () => {
    throw new AccError(EXIT.DATA, "managed directory escapes the store root", {});
  };

  await assert.rejects(sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:00:00.000Z"),
    withLock }), error => error.code === EXIT.DATA);
});

test("a sweep a day later is due again", async t => {
  const { root, paths } = await fixture(t, 1);
  await mkdir(paths.locks, { recursive: true });
  await sweepIfDue(paths, { root, clock: clockAt("2026-09-23T10:00:00.000Z") });
  await writeFile(path.join(paths.stage, "later.published"), "{}\n");

  const result = await sweepIfDue(paths, { root, clock: clockAt("2026-09-24T10:00:01.000Z") });

  assert.equal(result.swept, 1);
  assert.deepEqual(await readdir(paths.stage), []);
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

// The tests above run against files a fixture wrote, which proves the mechanism
// and not the claim behind it: that an accepted stage is a redundant second name
// for bytes already committed. These open a real store and read the record back.
const NOW = "2026-09-23T10:00:00.000Z";
const WORKSPACE = "workspace_a";

const workspaceRecord = () => ({ schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE,
  displayName: "Example", source: "directory", roots: ["/tmp/example"], createdAt: NOW });

async function liveStore(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-sweep-live-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE });
  return { root, store, paths: storePaths(root) };
}

test("a record stays readable after its accepted stage is swept", async t => {
  const { root, store, paths } = await liveStore(t);
  await store.transaction(async tx => { tx.put("workspace", WORKSPACE, workspaceRecord()); });
  assert.ok((await readdir(paths.stage)).length > 0,
    "the publication should have left an accepted stage");

  await sweepAcceptedStages(paths, { root });

  assert.deepEqual(await readdir(paths.stage), []);
  const snapshot = await store.snapshot(WORKSPACE);
  assert.equal(snapshot.workspace.workspaceId, WORKSPACE);
});

test("publishing again after a sweep is unharmed by the missing stage", async t => {
  const { root, store, paths } = await liveStore(t);
  await store.transaction(async tx => { tx.put("workspace", WORKSPACE, workspaceRecord()); });
  await sweepAcceptedStages(paths, { root });

  await store.transaction(async tx => {
    tx.put("workspace", WORKSPACE, { ...workspaceRecord(), displayName: "Renamed" },
      tx.generationOf("workspace", WORKSPACE));
  });

  const snapshot = await store.snapshot(WORKSPACE);
  assert.equal(snapshot.workspace.displayName, "Renamed");
});
