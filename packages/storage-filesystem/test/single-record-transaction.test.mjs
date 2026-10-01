import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { activateJournal } from "../src/active-journal.mjs";
import { openFilesystemStore, storePaths } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

// A session's heartbeat, every turn, is one record replaced and no event. It
// went through the whole journal: an entry prepared, activated, the record
// published, the entry marked complete and the journal set idle - five atomic
// writes, ten flushes on Windows, where one costs 8 to 23 ms on windows-latest.
// One record needs no journal to appear at once: a rename replaces it
// atomically. It is published directly when no other transaction is open; an
// open one refuses it, as it refuses a journalled write.
const NOW = "2026-09-30T20:00:00.000Z";
const WORKSPACE = "workspace_a";
const workspace = displayName => ({ schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE,
  displayName, source: "directory", roots: ["/tmp/example"], createdAt: NOW });

async function store(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-one-record-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE });
  return { root, store: opened, paths: storePaths(root) };
}

test("one record replaced with no event is published without the journal", async t => {
  const { store: opened, paths } = await store(t);
  await opened.transaction(tx => { tx.put("workspace", WORKSPACE, workspace("first")); },
    { kinds: ["workspace"] });
  const journalBefore = await readdir(paths.journal);

  await opened.transaction(tx => {
    tx.put("workspace", WORKSPACE, workspace("second"), tx.generationOf("workspace", WORKSPACE));
  }, { kinds: ["workspace"] });

  assert.deepEqual(await readdir(paths.journal), journalBefore, "the journal was written");
  assert.equal((await opened.snapshot(WORKSPACE, { kinds: ["workspace"] })).workspace.displayName,
    "second");
});

test("a record and an event still go through the journal", async t => {
  const { store: opened, paths } = await store(t);
  const before = await readdir(paths.journal);
  await opened.transaction(tx => {
    tx.put("workspace", WORKSPACE, workspace("first"));
    tx.append({ schemaVersion: SCHEMA_VERSION, eventId: "event_a", workspaceId: WORKSPACE,
      actorSessionId: "session_a", type: "workspace.materialised", occurredAt: NOW, payload: {} });
  }, { kinds: ["workspace"] });
  assert.notDeepEqual(await readdir(paths.journal), before, "a two-file write skipped the journal");
});

test("an open transaction refuses a one-record write, as it refuses a journalled one", async t => {
  const { root, store: opened, paths } = await store(t);
  await opened.transaction(tx => { tx.put("workspace", WORKSPACE, workspace("first")); },
    { kinds: ["workspace"] });
  const file = path.join(paths.state, "workspace", `${WORKSPACE}.json`);
  const before = await readFile(file, "utf8");
  await activateJournal({ root, journal: paths.journal }, { root },
    { transactionId: "transaction_crashed", firstSequence: "0000000000000001" });

  await assert.rejects(opened.transaction(tx => {
    tx.put("workspace", WORKSPACE, workspace("second"), tx.generationOf("workspace", WORKSPACE));
  }, { kinds: ["workspace"] }));
  assert.equal(await readFile(file, "utf8"), before, "a write landed past an open transaction");
});
