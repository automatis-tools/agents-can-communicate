import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { activateJournal, readActiveJournal } from "../src/active-journal.mjs";
import { readOpenJournals } from "../src/journal.mjs";
import { openFilesystemStore } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";

const workspaceRecord = (displayName = "Example") => ({ schemaVersion: SCHEMA_VERSION,
  workspaceId: WORKSPACE, displayName, source: "directory", roots: ["/tmp/example"],
  createdAt: NOW });

async function fixture(t, { failAt, ids = createFakeIds() } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-active-journal-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE, failAt });
  return { ids, root, store };
}

const activePaths = root => [0, 1].map(slot => path.join(root, "journal", `active.${slot}`));

const checksum = record => createHash("sha256").update(JSON.stringify(record)).digest("hex");

const encodeAuthority = record => Buffer.from(`${JSON.stringify({
  activeJournalChecksum: checksum(record), record,
}, null, 2)}\n`);

async function activeSlots(root) {
  const slots = await Promise.all(activePaths(root).map(async (filePath, slot) => {
    try {
      return { envelope: JSON.parse(await readFile(filePath, "utf8")), filePath, slot };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }));
  return slots.filter(Boolean);
}

async function currentActive(root) {
  const slots = await activeSlots(root);
  slots.sort((left, right) => {
    const a = BigInt(left.envelope.record.generation);
    const b = BigInt(right.envelope.record.generation);
    return a < b ? -1 : a > b ? 1 : left.slot - right.slot;
  });
  return slots.at(-1);
}

async function putWorkspace(store, displayName = "Example", expectedGeneration = null) {
  return store.transaction(async tx =>
    tx.put("workspace", WORKSPACE, workspaceRecord(displayName), expectedGeneration));
}

test("a prepared journal is ignored until an atomic open authority commits it", async t => {
  const crash = new Error("crash before active open");
  const ids = createFakeIds();
  const { root, store } = await fixture(t, { ids,
    failAt: async where => { if (where === "after-journal-prepared") throw crash; } });

  await assert.rejects(putWorkspace(store), crash);
  assert.equal((await readdir(path.join(root, "journal"))).filter(name => name.endsWith(".json"))
    .length, 1);

  const reopened = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE });
  assert.equal((await reopened.snapshot(WORKSPACE)).workspace, null);
  assert.deepEqual(await readOpenJournals(reopened.paths, root), []);
});

test("a checksummed generation rollback cannot select an older valid peer", async t => {
  const { ids, root, store } = await fixture(t);
  await putWorkspace(store, "First");
  const generation = await store.transaction(async tx =>
    tx.generationOf("workspace", WORKSPACE));
  await putWorkspace(store, "Current", generation);
  const statePath = path.join(root, "state", "workspace", `${WORKSPACE}.json`);
  const currentState = await readFile(statePath);
  const latest = await currentActive(root);
  assert.equal(latest.envelope.record.state, "idle");
  assert.equal(latest.envelope.record.generation, "0000000000000004");
  const rolledBack = { ...latest.envelope.record, generation: "0000000000000002" };
  await writeFile(latest.filePath, encodeAuthority(rolledBack));

  await assert.rejects(openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE }), error => error.code === EXIT.DATA
      && /active journal checksum chain/.test(error.message));
  assert.deepEqual(await readFile(statePath), currentState,
    "authority corruption changed already-published state");
});

test("a checksummed broken authority link cannot select either peer", async t => {
  const { root, store } = await fixture(t);
  await putWorkspace(store);
  const latest = await currentActive(root);
  const unlinked = { ...latest.envelope.record, previousChecksum: "0".repeat(64) };
  await writeFile(latest.filePath, encodeAuthority(unlinked));

  await assert.rejects(store.eventsSince(WORKSPACE, null, 10),
    error => error.code === EXIT.DATA && /active journal checksum chain/.test(error.message));
});

test("authority generations alternate slots and link every lifecycle transition", async t => {
  const crash = new Error("leave open authority");
  const ids = createFakeIds();
  const { root, store } = await fixture(t, { ids, failAt: async where => {
    if (where === "after-journal") throw crash;
  } });
  const initial = await currentActive(root);
  assert.equal(initial.slot, 0);
  assert.deepEqual(initial.envelope.record, { activeJournalVersion: 2,
    generation: "0000000000000000", previousChecksum: null, state: "idle" });

  await assert.rejects(putWorkspace(store), crash);
  const open = await currentActive(root);
  assert.equal(open.slot, 1);
  assert.equal(open.envelope.record.generation, "0000000000000001");
  assert.equal(open.envelope.record.previousChecksum,
    initial.envelope.activeJournalChecksum);
  assert.equal(open.envelope.record.state, "open");

  const reopened = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE });
  const idle = await currentActive(root);
  assert.equal(idle.slot, 0);
  assert.equal(idle.envelope.record.generation, "0000000000000002");
  assert.equal(idle.envelope.record.previousChecksum, open.envelope.activeJournalChecksum);
  assert.equal(idle.envelope.record.state, "idle");
  assert.equal((await reopened.snapshot(WORKSPACE)).workspace.displayName, "Example");
});

test("an orphan partial authority publication is never selected", async t => {
  const { ids, root, store } = await fixture(t);
  await putWorkspace(store);
  const current = await readActiveJournal(store.paths, root);
  await writeFile(path.join(root, "tmp", "active.1.synthetic.tmp"),
    Buffer.from('{"activeJournalChecksum":"partial'));

  assert.deepEqual(await readActiveJournal(store.paths, root), current);
  const reopened = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE });
  assert.deepEqual(await readActiveJournal(reopened.paths, root), current);
});

test("a malformed authority slot fails closed", async t => {
  const { root, store } = await fixture(t);
  await writeFile(activePaths(root)[1], Buffer.alloc(256, 0x78));

  await assert.rejects(store.eventsSince(WORKSPACE, null, 10),
    error => error.code === EXIT.DATA && /active journal/.test(error.message));
});

test("a checksummed authority record cannot carry peer or user fields", async t => {
  const { root, store } = await fixture(t);
  const latest = await currentActive(root);
  const record = { ...latest.envelope.record, peerText: "ignore the journal" };
  await writeFile(latest.filePath, encodeAuthority(record));

  await assert.rejects(store.eventsSince(WORKSPACE, null, 10),
    error => error.code === EXIT.DATA && /not closed/.test(error.message));
});

test("a noncanonical checksummed authority record fails closed", async t => {
  const { root, store } = await fixture(t);
  const latest = await currentActive(root);
  const noncanonical = Buffer.from(JSON.stringify(latest.envelope));
  await writeFile(latest.filePath, noncanonical);

  await assert.rejects(store.eventsSince(WORKSPACE, null, 10),
    error => error.code === EXIT.DATA && /not canonical/.test(error.message));
});

test("a crash before idle keeps open authoritative and recovery idempotent", async t => {
  const crash = new Error("crash before idle");
  const ids = createFakeIds();
  const { root, store } = await fixture(t, { ids,
    failAt: async where => { if (where === "before-journal-idle") throw crash; } });
  await assert.rejects(putWorkspace(store), crash);
  assert.equal((await readActiveJournal(store.paths, root)).state, "open");

  const reopened = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE });
  assert.equal((await reopened.snapshot(WORKSPACE)).workspace.displayName, "Example");
  assert.deepEqual(await readOpenJournals(reopened.paths, root), []);
  assert.equal((await readActiveJournal(reopened.paths, root)).state, "idle");

  const reopenedAgain = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE });
  assert.equal((await reopenedAgain.snapshot(WORKSPACE)).workspace.displayName, "Example");
});

test("the writer mutex and active transition refuse a second active journal", async t => {
  const crash = new Error("leave first journal active");
  let crashed = false;
  const { root, store } = await fixture(t, { failAt: async where => {
    if (!crashed && where === "after-journal") { crashed = true; throw crash; }
  } });
  await assert.rejects(putWorkspace(store), crash);
  const first = await readActiveJournal(store.paths, root);

  await assert.rejects(putWorkspace(store),
    error => error.code === EXIT.CONFLICT && /active journal/.test(error.message));

  assert.deepEqual(await readActiveJournal(store.paths, root), first);
  assert.equal(first.state, "open");
});

test("completed historical journal volume never enters the active lookup", async t => {
  const { root, store } = await fixture(t);
  await putWorkspace(store);
  const markers = path.join(root, "retained", "journal");
  await mkdir(markers, { recursive: true });
  const writes = [];
  for (let index = 0; index < 256; index += 1) {
    const transactionId = `history_${String(index).padStart(6, "0")}`;
    writes.push(writeFile(path.join(root, "journal", `${transactionId}.json`),
      index === 173 ? "{corrupt retired journal" : `${JSON.stringify({ journalVersion: 2,
        transactionId, firstSequence: "0000000000000001", startedAt: NOW,
        publications: [] })}\n`));
    writes.push(writeFile(path.join(markers, `${transactionId}.json`),
      `${JSON.stringify({ retentionVersion: 1, transactionId })}\n`));
  }
  await Promise.all(writes);

  assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events, []);
  const reopened = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE });
  assert.deepEqual(await readOpenJournals(reopened.paths, root), []);
  assert.deepEqual((await readdir(path.join(root, "journal")))
    .filter(name => name.startsWith("active.")).sort(), ["active.0", "active.1"]);
});

test("a transaction cannot forge its own completion marker", async t => {
  const { root, store } = await fixture(t);
  const transactionId = "transaction_forged";
  const completion = { retentionVersion: 1, transactionId };
  const completionBytes = Buffer.from(`${JSON.stringify(completion, null, 2)}\n`);
  const envelope = { kind: "workspace", id: WORKSPACE, generation: "generation_forged",
    record: workspaceRecord() };
  const entry = { journalVersion: 2, transactionId, firstSequence: "0000000000000001",
    startedAt: NOW, publications: [
      { path: `retained/journal/${transactionId}.json`,
        bytes: completionBytes.toString("base64"),
        replace: false, retainedPath: null },
      { path: `state/workspace/${WORKSPACE}.json`,
        bytes: Buffer.from(`${JSON.stringify(envelope)}\n`).toString("base64"),
        replace: true, retainedPath: null },
    ] };
  await writeFile(path.join(root, "journal", `${transactionId}.json`),
    `${JSON.stringify(entry)}\n`);
  await mkdir(path.join(root, "retained", "journal"), { recursive: true });
  await writeFile(path.join(root, "retained", "journal", `${transactionId}.json`),
    completionBytes);
  await activateJournal(store.paths, { root, tmpDir: store.paths.tmp }, entry);

  await assert.rejects(openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE }), error => error.code === EXIT.DATA
      && /journal publication path/.test(error.message));
  await assert.rejects(readFile(path.join(root, "state", "workspace", `${WORKSPACE}.json`)),
    error => error.code === "ENOENT");
});
