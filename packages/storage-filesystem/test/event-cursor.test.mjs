import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { raiseEventFloor } from "../src/event-floor.mjs";
import { readOpenJournals } from "../src/journal.mjs";
import { ZERO_CURSOR, openFilesystemStore } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

// A wait for the next message starts from the newest event (#147). Reading the
// whole log to find it would cost a second per wait on a store of ten thousand
// events, so the cursor comes from file names - and it must still stop where
// eventsSince stops, or the wait would skip or repeat what a reader sees.

const WORKSPACE = "workspace_a";
const NOW = "2026-11-25T01:00:00.000Z";

async function open(t, failAt) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cursor-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { clock: createFakeClock(NOW), ids: createFakeIds(), workspaceId: WORKSPACE };
  return { root, options, store: await openFilesystemStore({ root, ...options, failAt }) };
}

const append = (store, index) => store.transaction(async tx => tx.append({
  schemaVersion: SCHEMA_VERSION, eventId: `event_${index}`, workspaceId: WORKSPACE,
  actorSessionId: "session_a", type: "intent.published", occurredAt: NOW,
  payload: { mode: "edit", state: "active" } }), { kinds: [] });

const readToEnd = async store => (await store.eventsSince(WORKSPACE, null, 10_000)).cursor;

test("the cursor of an empty log is where reading starts", async t => {
  const { store } = await open(t);
  assert.equal(await store.eventCursor(WORKSPACE), ZERO_CURSOR);
  assert.equal(await store.eventCursor(WORKSPACE), await readToEnd(store));
});

test("the cursor is the newest event, the same place eventsSince reaches", async t => {
  const { store } = await open(t);
  for (let index = 0; index < 3; index += 1) await append(store, index);
  assert.equal(await store.eventCursor(WORKSPACE), "0000000000000003");
  assert.equal(await store.eventCursor(WORKSPACE), await readToEnd(store));
});

test("a log trimmed away entirely answers with its boundary", async t => {
  const { root, store } = await open(t);
  await raiseEventFloor(store.paths, { root, tmpDir: store.paths.tmp }, "0000000000000007");
  assert.equal(await store.eventCursor(WORKSPACE), "0000000000000007");
});

test("a decided but unpublished transaction stays beyond the cursor", async t => {
  const crash = new Error("stopped after the journal");
  let armed = false;
  const { root, options, store } = await open(t, async where => {
    // Stop after the event file is published and before the journal closes: a
    // reader must not see that event yet, and neither may the cursor.
    if (armed && where.startsWith("after:") && where.includes("events")) throw crash;
  });
  await append(store, 0);
  armed = true;
  await assert.rejects(append(store, 1), error => error === crash);
  assert.equal((await readOpenJournals(store.paths, root)).length, 1);
  assert.ok((await readdir(store.paths.events)).includes("0000000000000002.json"));
  assert.equal(await store.eventCursor(WORKSPACE), "0000000000000001");
  assert.equal(await store.eventCursor(WORKSPACE), await readToEnd(store));
  // Recovery publishes it, and the cursor moves with what a reader now sees.
  const reopened = await openFilesystemStore({ root, ...options });
  await reopened.transaction(async () => {}, { kinds: [] });
  assert.equal(await reopened.eventCursor(WORKSPACE), "0000000000000002");
});
