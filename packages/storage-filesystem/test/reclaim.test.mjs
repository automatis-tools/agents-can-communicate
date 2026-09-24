import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { initialiseActiveJournal, activateJournal } from "../src/active-journal.mjs";
import { reclaimRetired } from "../src/reclaim.mjs";
import { storePaths } from "../src/store.mjs";

async function fixture(t, { active = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-reclaim-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = storePaths(root);
  for (const name of ["journal", "locks", "tmp", "stage", "retained"]) {
    await mkdir(paths[name], { recursive: true });
  }
  await mkdir(path.join(paths.retained, "journal"), { recursive: true });
  if (active) await initialiseActiveJournal(paths, { root, tmpDir: paths.tmp });
  return { root, paths };
}

// The active-journal authority lives in the same directory, as `active.0` and
// `active.1`. It carries no .json extension, which is why the reclaimer never
// sees it, and why the tests count only the entries.
const journalEntries = async paths =>
  (await readdir(paths.journal)).filter(name => name.endsWith(".json"));
const completionMarkers = paths => readdir(path.join(paths.retained, "journal"));

async function completed(paths, transactionId) {
  await writeFile(path.join(paths.journal, `${transactionId}.json`), "{}\n");
  await writeFile(path.join(paths.retained, "journal", `${transactionId}.json`), "{}\n");
}

async function ephemeralMarkers(paths, kind, id, count) {
  const directory = path.join(paths.retained, "ephemeral", kind, id);
  await mkdir(directory, { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    await writeFile(path.join(directory, `${String(index).padStart(16, "0")}.json`), "{}\n");
  }
  return directory;
}

test("a completed journal entry leaves with its completion marker", async t => {
  const { root, paths } = await fixture(t);
  await completed(paths, "transaction_a");

  const result = await reclaimRetired(paths, { root });

  // Both halves go together. Leaving the marker behind would keep the record
  // that says a file nothing can find was completed.
  assert.equal(result.remaining, false);
  assert.deepEqual(await journalEntries(paths), []);
  assert.deepEqual(await completionMarkers(paths), []);
  assert.equal(result.reclaimed, 2);
});

test("an entry with no completion marker stays", async t => {
  const { root, paths } = await fixture(t);
  await writeFile(path.join(paths.journal, "transaction_open.json"), "{}\n");

  const result = await reclaimRetired(paths, { root });

  // No marker means the transaction was never retired, and recovery may still
  // have to roll it forward.
  assert.equal(result.reclaimed, 0);
  assert.deepEqual(await journalEntries(paths), ["transaction_open.json"]);
});

test("the active journal entry stays even when a marker says it completed", async t => {
  const { root, paths } = await fixture(t);
  await completed(paths, "transaction_live");
  await activateJournal(paths, { root, tmpDir: paths.tmp },
    { transactionId: "transaction_live", firstSequence: "0".repeat(16) });

  const result = await reclaimRetired(paths, { root });

  // `retireJournalEntry` writes the marker before it idles the pointer, so a
  // crash between the two leaves exactly this state. Moving the entry would
  // make readOpenJournals throw on a store that is merely mid-retirement.
  assert.equal(result.reclaimed, 0);
  assert.deepEqual(await journalEntries(paths), ["transaction_live.json"]);
});

test("a store whose active journal cannot be read reclaims no journal entry", async t => {
  const { root, paths } = await fixture(t, { active: false });
  await completed(paths, "transaction_a");

  const result = await reclaimRetired(paths, { root });

  // Not knowing which entry is active is not a licence to guess.
  assert.equal(result.reclaimed, 0);
  assert.deepEqual(await journalEntries(paths), ["transaction_a.json"]);
});

test("superseded ephemeral markers leave and the newest stays", async t => {
  const { root, paths } = await fixture(t);
  const directory = await ephemeralMarkers(paths, "binding", "session_a", 4);

  const result = await reclaimRetired(paths, { root });

  // latestEphemeralMarker reads only the newest and lists the rest to find it,
  // so the older ones are pure listing cost.
  assert.equal(result.reclaimed, 3);
  assert.deepEqual(await readdir(directory), [`${"0".repeat(15)}4.json`]);
});

test("a record with one ephemeral marker is left alone", async t => {
  const { root, paths } = await fixture(t);
  const directory = await ephemeralMarkers(paths, "binding", "session_b", 1);

  const result = await reclaimRetired(paths, { root });

  assert.equal(result.reclaimed, 0);
  assert.equal((await readdir(directory)).length, 1);
});

test("reclaiming stops at its budget and reports the remainder", async t => {
  const { root, paths } = await fixture(t);
  await completed(paths, "transaction_a");
  await completed(paths, "transaction_b");
  await completed(paths, "transaction_c");

  const result = await reclaimRetired(paths, { root, limit: 2 });

  assert.equal(result.remaining, true);
  // The budget bought two moves and had nothing left to discard with, so one
  // pair left its live names without yet leaving the store. `reclaimed` counts
  // what the store gave back, not what was condemned, and the next pass starts
  // by draining exactly that directory.
  assert.equal(result.reclaimed, 0);
  assert.equal((await journalEntries(paths)).length + (await completionMarkers(paths)).length, 4);

  const second = await reclaimRetired(paths, { root });
  assert.equal(second.reclaimed, 6);
  assert.equal(second.remaining, false);
  assert.deepEqual(await journalEntries(paths), []);
});

test("an expired budget reclaims nothing rather than failing", async t => {
  const { root, paths } = await fixture(t);
  await completed(paths, "transaction_a");

  const result = await reclaimRetired(paths, { root, deadlineAt: Date.now() - 1 });

  assert.deepEqual(result, { reclaimed: 0, remaining: true });
  assert.equal((await journalEntries(paths)).length, 1);
});
