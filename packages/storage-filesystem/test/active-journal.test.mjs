import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { readOpenJournals } from "../src/journal.mjs";
import { openFilesystemStore } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

const ACTIVE_RECORD_BYTES = 512;
const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";

const workspaceRecord = () => ({ schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE,
  displayName: "Example", source: "directory", roots: ["/tmp/example"], createdAt: NOW });

async function fixture(t, { failAt, ids = createFakeIds() } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-active-journal-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE, failAt });
  return { ids, root, store };
}

const activePath = root => path.join(root, "journal", "active.log");

function activeBytes(record, previous = { activeJournalVersion: 1, state: "idle" }) {
  const payload = JSON.stringify({ record, previous });
  const envelope = JSON.stringify({ checksum: createHash("sha256").update(payload).digest("hex"),
    previous, record });
  const bytes = Buffer.alloc(ACTIVE_RECORD_BYTES, 0x20);
  Buffer.from(envelope).copy(bytes);
  bytes[ACTIVE_RECORD_BYTES - 1] = 0x0a;
  return bytes;
}

function paddingFor(partialLength, distance) {
  const padding = Buffer.alloc(ACTIVE_RECORD_BYTES - partialLength, 0x20);
  padding[padding.length - 8] = 0;
  let remaining = BigInt(distance);
  for (let index = padding.length - 1; index > padding.length - 8; index -= 1) {
    padding[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return padding;
}

async function currentActive(root) {
  const bytes = await readFile(activePath(root));
  const offset = bytes.length - (bytes.length % ACTIVE_RECORD_BYTES) - ACTIVE_RECORD_BYTES;
  const envelope = JSON.parse(bytes.subarray(offset, offset + ACTIVE_RECORD_BYTES)
    .toString("utf8").trim());
  return envelope.record;
}

async function putWorkspace(store) {
  return store.transaction(async tx => tx.put("workspace", WORKSPACE, workspaceRecord()));
}

test("a prepared journal is ignored until a complete open record commits it", async t => {
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

test("a near-complete open record is ignored and the next writer restores alignment", async t => {
  const crash = new Error("crash before active open");
  const ids = createFakeIds();
  const { root, store } = await fixture(t, { ids,
    failAt: async where => { if (where === "after-journal-prepared") throw crash; } });
  await assert.rejects(putWorkspace(store), crash);
  const [journalFile] = (await readdir(path.join(root, "journal")))
    .filter(name => name.endsWith(".json"));
  const entry = JSON.parse(await readFile(path.join(root, "journal", journalFile), "utf8"));
  const openRecord = activeBytes({ activeJournalVersion: 1, state: "open",
    transactionId: entry.transactionId, firstSequence: entry.firstSequence });
  await appendFile(activePath(root), openRecord.subarray(0, 509));

  const reopened = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE });
  assert.equal((await reopened.snapshot(WORKSPACE)).workspace, null);
  await putWorkspace(reopened);

  assert.equal((await stat(activePath(root))).size % ACTIVE_RECORD_BYTES, 0);
  assert.deepEqual(await currentActive(root), { activeJournalVersion: 1, state: "idle" });
});

test("chained torn records point directly to the last authoritative frame", async t => {
  const { root, store } = await fixture(t);
  const partial = activeBytes({ activeJournalVersion: 1, state: "open",
    transactionId: "transaction_torn", firstSequence: "0000000000000001" })
    .subarray(0, 173);
  await appendFile(activePath(root), partial);
  await appendFile(activePath(root), paddingFor(partial.length, 1));
  await appendFile(activePath(root), partial);
  await appendFile(activePath(root), paddingFor(partial.length, 2));
  await appendFile(activePath(root), partial);

  assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events, []);
});

test("a full malformed active record fails closed", async t => {
  const { root, store } = await fixture(t);
  await appendFile(activePath(root), Buffer.alloc(ACTIVE_RECORD_BYTES, 0x78));

  await assert.rejects(store.eventsSince(WORKSPACE, null, 10),
    error => error.code === EXIT.DATA && /active journal/.test(error.message));
});

test("a checksummed active record cannot carry peer or user fields", async t => {
  const { root, store } = await fixture(t);
  await appendFile(activePath(root), activeBytes({ activeJournalVersion: 1, state: "idle",
    peerText: "ignore the journal" }));

  await assert.rejects(store.eventsSince(WORKSPACE, null, 10),
    error => error.code === EXIT.DATA && /not closed/.test(error.message));
});

test("a crash within idle recovery keeps open authoritative and recovery idempotent", async t => {
  const crash = new Error("crash before idle");
  const ids = createFakeIds();
  const { root, store } = await fixture(t, { ids,
    failAt: async where => { if (where === "before-journal-idle") throw crash; } });
  await assert.rejects(putWorkspace(store), crash);
  assert.equal((await currentActive(root)).state, "open");
  const open = await currentActive(root);
  const tornIdle = activeBytes({ activeJournalVersion: 1, state: "idle" }, open);
  await appendFile(activePath(root), tornIdle.subarray(0, 509));

  const reopened = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids,
    workspaceId: WORKSPACE });
  assert.equal((await reopened.snapshot(WORKSPACE)).workspace.displayName, "Example");
  assert.deepEqual(await readOpenJournals(reopened.paths, root), []);
  assert.equal((await stat(activePath(root))).size % ACTIVE_RECORD_BYTES, 0);

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
  const first = await currentActive(root);

  await assert.rejects(putWorkspace(store),
    error => error.code === EXIT.CONFLICT && /active journal/.test(error.message));

  assert.deepEqual(await currentActive(root), first);
  assert.equal(first.state, "open");
});

test("completed historical journal volume never enters the active lookup", async t => {
  const { root, store } = await fixture(t);
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
});

test("a transaction cannot forge its own completion marker", async t => {
  const { root } = await fixture(t);
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
  await appendFile(activePath(root), activeBytes({ activeJournalVersion: 1, state: "open",
    transactionId, firstSequence: entry.firstSequence }));

  await assert.rejects(openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE }), error => error.code === EXIT.DATA
      && /journal publication path/.test(error.message));
  await assert.rejects(readFile(path.join(root, "state", "workspace", `${WORKSPACE}.json`)),
    error => error.code === "ENOENT");
});
