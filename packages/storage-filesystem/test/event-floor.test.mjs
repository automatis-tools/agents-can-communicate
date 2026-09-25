import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { publishAtomic } from "../src/atomic-json.mjs";
import { readEventFloor } from "../src/event-floor.mjs";
import { openFilesystemStore, storePaths } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

const WORKSPACE = "workspace_a";
const NOW = "2026-09-24T01:00:00.000Z";

async function store(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-floor-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE });
  return { root, store: opened };
}

async function appendEvents(opened, count) {
  const sequences = [];
  for (let index = 0; index < count; index += 1) {
    await opened.transaction(async tx => {
      sequences.push(tx.append({ schemaVersion: SCHEMA_VERSION, eventId: `event_${index}`,
        workspaceId: WORKSPACE, actorSessionId: "session_a", type: "intent.published",
        occurredAt: NOW, payload: { mode: "edit", state: "active" } }).sequence);
    }, { kinds: [] });
  }
  return sequences;
}

test("trimming removes events at or below the boundary and keeps the rest", async t => {
  const { root, store: opened } = await store(t);
  const sequences = await appendEvents(opened, 5);

  const result = await opened.trimHistory(sequences[2]);

  assert.equal(result.reclaimed, 3);
  assert.equal(result.trimmedThrough, sequences[2]);
  const page = await opened.eventsSince(WORKSPACE, null, 50);
  assert.deepEqual(page.events.map(event => event.sequence), sequences.slice(3));
});

test("a cursor below the boundary is answered with the boundary", async t => {
  const { root, store: opened } = await store(t);
  const sequences = await appendEvents(opened, 4);
  await opened.trimHistory(sequences[1]);

  const page = await opened.eventsSince(WORKSPACE, null, 50);

  // A short page that reads like a complete one is what the floor exists to
  // prevent: the caller has to be able to tell that the log starts later than
  // its cursor does.
  assert.equal(page.trimmedThrough, sequences[1]);
  assert.equal(page.events.length, 2);
});

test("an untrimmed store reports no boundary at all", async t => {
  const { store: opened } = await store(t);
  await appendEvents(opened, 2);

  assert.equal((await opened.eventsSince(WORKSPACE, null, 50)).trimmedThrough, null);
});

test("the floor is raised, never lowered", async t => {
  const { root, store: opened } = await store(t);
  const sequences = await appendEvents(opened, 4);
  await opened.trimHistory(sequences[2]);

  const result = await opened.trimHistory(sequences[0]);

  // An operator naming an earlier point has asked for nothing, and honouring
  // it would claim events are available that have already gone.
  assert.equal(result.trimmedThrough, sequences[2]);
  assert.equal(await readEventFloor(opened.paths, root), sequences[2]);
});

test("a sequence allocated after a full trim never repeats a served one", async t => {
  const { store: opened } = await store(t);
  const sequences = await appendEvents(opened, 3);
  await opened.trimHistory(sequences.at(-1));
  assert.deepEqual((await opened.eventsSince(WORKSPACE, null, 50)).events, []);

  const next = await appendEvents(opened, 1);

  // The directory is empty, so the newest file cannot answer. Restarting at 1
  // would hand out a sequence a peer already holds a cursor for.
  assert.ok(next[0] > sequences.at(-1));
});

test("a boundary that is not a sequence is refused", async t => {
  const { store: opened } = await store(t);

  await assert.rejects(opened.trimHistory("yesterday"),
    error => error.code === EXIT.USAGE);
});

test("trimming leaves no detached directory behind", async t => {
  const { root, store: opened } = await store(t);
  const sequences = await appendEvents(opened, 3);

  await opened.trimHistory(sequences[1]);

  assert.deepEqual((await readdir(root)).filter(name => name.startsWith("stage.sweeping-")), []);
});

test("a publication survives the sweep taking its staging directory away", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-stage-race-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = storePaths(root);
  await mkdir(paths.tmp, { recursive: true });
  await mkdir(paths.stage, { recursive: true });
  await mkdir(path.join(root, "state"), { recursive: true });

  // The sweep empties `stage/` by renaming it aside and recreating it. A
  // publication that began before that swap used to arrive at a name that was
  // gone, and failed a write whose bytes were already linked into place. The
  // seam puts the swap exactly inside that window.
  await publishAtomic(path.join(root, "state", "record.json"), Buffer.from("{}\n"), {
    root,
    tmpDir: paths.tmp,
    stageDir: paths.stage,
    afterAccepted: () => rename(paths.stage, path.join(root, "stage.taken-aside")),
  });

  assert.deepEqual(await readdir(path.join(root, "state")), ["record.json"]);
  assert.equal((await readdir(paths.stage)).length, 1);
});

test("a floor past the safe integer range refuses rather than repeating a sequence", async t => {
  const { store: opened } = await store(t);
  await appendEvents(opened, 1);

  await opened.trimHistory("9999999999999999");

  // Sixteen digits reach past Number.MAX_SAFE_INTEGER, where adding one stops
  // changing the value. Allocating from such a floor would hand out a sequence
  // a peer already holds a cursor for, so the store refuses instead.
  await assert.rejects(appendEvents(opened, 1), error => error.code === EXIT.DATA);
});
