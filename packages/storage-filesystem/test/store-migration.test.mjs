import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import * as storage from "../src/index.mjs";
import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";
import { encode } from "../src/atomic-json.mjs";
import { journalEntry, writeJournalEntry } from "../src/journal.mjs";
import { stateEnvelope } from "../src/record-id.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { exactMessage, EXACT_NOW as NOW, EXACT_WORKSPACE as WS } from "../../../tests/helpers/exact-transaction-contract.mjs";
import { INDEX_DIRECTORY } from "../src/index-io.mjs";

async function legacy(t, storeVersion = 6) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-store-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock(NOW), ids = createFakeIds();
  const opened = await storage.openFilesystemStore({ root, clock, ids, workspaceId: WS });
  await opened.transaction(tx => {
    tx.put("message", "message_a", exactMessage());
    tx.put("receipt", "receipt_a", { schemaVersion: SCHEMA_VERSION, workspaceId: WS,
      messageId: "message_a", recipientParticipantId: "participant_a", state: "queued", updatedAt: NOW });
    // A note its reader has retrieved: the one receipt the migration rewrites.
    tx.put("receipt", "receipt_b", { schemaVersion: SCHEMA_VERSION, workspaceId: WS,
      messageId: "message_a", recipientParticipantId: "participant_b", state: "retrieved", updatedAt: NOW });
  }, { kinds: ["message", "receipt"] });
  const identityFile = path.join(root, "protocol.json");
  const identity = { ...JSON.parse(await readFile(identityFile)), storeVersion };
  await writeFile(identityFile, encode(identity));
  return { root, paths: opened.paths, clock, ids, identity, identityFile,
    options: { root, workspaceId: WS, clock, ids, allowMigration: true } };
}
const migrate = options => {
  assert.equal(typeof storage.migrateFilesystemStore, "function", "explicit migration implementation missing");
  return storage.migrateFilesystemStore(options);
};
const primaryBytes = async root => Promise.all(["message/message_a", "receipt/receipt_a", "receipt/receipt_b"]
  .map(name => readFile(path.join(root, "state", name + ".json"))));
const CURRENT = storage.STORE_VERSION;
// Contract 8 writes the obligation into a note its reader has retrieved (#306); nothing else changes.
const receiptRecord = async root => JSON.parse(await readFile(path.join(root, "state/receipt/receipt_b.json"))).record;
async function sameRecords(root, before) {
  const [message, queued, retrieved] = before, [messageAfter, queuedAfter] = await primaryBytes(root);
  assert.deepEqual(messageAfter, message);
  assert.deepEqual(queuedAfter, queued);
  const { extensions, ...rest } = await receiptRecord(root);
  assert.deepEqual(extensions, { obligation: "none" });
  const { extensions: none, ...original } = JSON.parse(retrieved).record;
  assert.deepEqual(rest, original);
}

test("migration preserves records and initialized identity", async t => {
  const f = await legacy(t), before = await primaryBytes(f.root);
  await assert.rejects(storage.openFilesystemStore(f.options), error =>
    error.code === EXIT.DATA && /doctor --migrate-store/.test(error.message));
  assert.deepEqual(await migrate(f.options), { fromVersion: 6, toVersion: CURRENT, migrated: true });
  const after = JSON.parse(await readFile(f.identityFile));
  assert.deepEqual(after, { ...f.identity, storeVersion: CURRENT });
  await sameRecords(f.root, before);
  const opened = await storage.openFilesystemStore(f.options);
  assert.deepEqual(await opened.transaction(tx => tx.lookup("messageByClientKey", [WS, "participant_a", "client_a"]),
    { kinds: ["message"], exactKinds: ["message"] }), ["message_a"]);
  const migrated = await primaryBytes(f.root);
  assert.deepEqual(await migrate(f.options), { fromVersion: CURRENT, toVersion: CURRENT, migrated: false });
  assert.deepEqual(await primaryBytes(f.root), migrated);
});

test("a contract-7 store gains its receipts' obligations and a v2 cache, and its v1 cache goes", async t => {
  const f = await legacy(t, 7), before = await primaryBytes(f.root);
  // The cache ACC 0.12 kept beside the store.
  const legacyCache = path.join(f.root, "indexes", "v1");
  await mkdir(path.join(legacyCache, "pages"), { recursive: true });
  await writeFile(path.join(legacyCache, "cache.json"), "{}\n");
  await assert.rejects(storage.openFilesystemStore(f.options), error => error.code === EXIT.DATA
    && error.details?.reasonCode === "store_migration_required" && /doctor --migrate-store/.test(error.message));
  assert.deepEqual(await migrate(f.options), { fromVersion: 7, toVersion: CURRENT, migrated: true });
  await sameRecords(f.root, before);
  await assert.rejects(stat(path.join(legacyCache, "cache.json")), { code: "ENOENT" });
  const opened = await storage.openFilesystemStore(f.options);
  const lookup = tuple => opened.transaction(tx => tx.lookup("receiptsByRecipientState", tuple),
    { kinds: ["receipt"], exactKinds: ["receipt"] });
  assert.deepEqual(await lookup([WS, "participant_a", "queued"]), ["receipt_a"]);
  assert.deepEqual(await lookup([WS, "participant_b", "retrieved"]), [], "a retrieved note leaves the index");
});

// A receipt reader refuses a damaged record, so a rewritten receipt must never take its
// name before its bytes are on disk: a crash then leaves the old receipt or the new one.
test("the migration flushes each receipt it rewrites before the receipt takes its name", async t => {
  const f = await legacy(t, 7);
  const { measureTransactionIO } = await import("../../../tests/helpers/store-io-probe.mjs");
  const measured = await measureTransactionIO(f.root, () => migrate(f.options));
  assert.equal(measured.result.migrated, true);
  assert.equal(measured.io["state:receipt/publications"], 1);
  assert.equal(measured.io["state:receipt/publicationFlushes"], 1);
});

test("migration recovers decided version-six journal first", async t => {
  const f = await legacy(t);
  const record = exactMessage({ messageId: "message_recovered", threadId: "message_recovered", clientMessageId: "client_recovered" });
  const bytes = encode(stateEnvelope("message", record.messageId, "generation_recovered", record));
  await writeJournalEntry(f.paths, { root: f.root, tmpDir: f.paths.tmp },
    journalEntry("transaction_decided", "0000000000000001", [{ path: "state/message/message_recovered.json", bytes, replace: true }], NOW));
  let switched = false;
  await migrate({ ...f.options, failAt: async phase => {
    if (phase === "before-store-version-switch") {
      assert.deepEqual(await readFile(path.join(f.root, "state/message/message_recovered.json")), bytes);
      switched = true;
    }
  } });
  assert.equal(switched, true);
  const opened = await storage.openFilesystemStore(f.options);
  assert.deepEqual(await opened.transaction(tx => tx.lookup("messageByClientKey", [WS, "participant_a", "client_recovered"]),
    { kinds: ["message"], exactKinds: ["message"] }), ["message_recovered"]);
  assert.deepEqual(await readFile(path.join(f.root, "state/message/message_recovered.json")), bytes);
});

for (const phase of ["after-index-pages", "before-store-version-switch", "after-store-version-switch"]) {
  test(`interrupted migration is retryable at ${phase}`, async t => {
    const f = await legacy(t), before = await primaryBytes(f.root);
    let hit = false;
    await assert.rejects(migrate({ ...f.options, failAt: where => {
      if (where === phase) { hit = true; throw new Error("interrupted migration"); }
    } }));
    assert.equal(hit, true, "the migration must reach this publication boundary");
    assert.equal(JSON.parse(await readFile(f.identityFile)).storeVersion,
      phase === "after-store-version-switch" ? CURRENT : 6);
    const result = await migrate(f.options);
    assert.equal(result.toVersion, CURRENT);
    assert.equal(result.migrated, phase !== "after-store-version-switch");
    await sameRecords(f.root, before);
  });
}

test("migration refuses absent opt-in, deadlines and invalid identity without switching", async t => {
  const f = await legacy(t);
  await assert.rejects(migrate({ ...f.options, allowMigration: false }), { code: EXIT.USAGE });
  await assert.rejects(migrate({ ...f.options, deadlineAt: 0 }), { code: EXIT.CONFLICT });
  for (const identity of [{ ...f.identity, storeVersion: CURRENT + 1 }, { ...f.identity, workspaceId: "workspace_other" },
    { ...f.identity, initialisedAt: null }, { ...f.identity, extra: "unknown" }]) {
    const before = encode(identity); await writeFile(f.identityFile, before);
    await assert.rejects(migrate(f.options), { code: EXIT.DATA });
    assert.deepEqual(await readFile(f.identityFile), before);
  }
});

test("migration refuses corrupt primary and verifies cache again on the current version", async t => {
  const f = await legacy(t), file = path.join(f.root, "state/message/message_a.json");
  const bytes = await readFile(file);
  await writeFile(file, "invalid primary bytes");
  await assert.rejects(migrate(f.options), { code: EXIT.DATA });
  assert.equal(JSON.parse(await readFile(f.identityFile)).storeVersion, 6);
  await writeFile(file, bytes); await migrate(f.options);
  const manifestFile = path.join(f.root, INDEX_DIRECTORY, "cache.json");
  await rm(manifestFile);
  assert.deepEqual(await migrate(f.options), { fromVersion: CURRENT, toVersion: CURRENT, migrated: false });
  assert.equal(JSON.parse(await readFile(manifestFile)).workspaceId, WS);
});
