import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function legacy(t) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-store-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock(NOW), ids = createFakeIds();
  const opened = await storage.openFilesystemStore({ root, clock, ids, workspaceId: WS });
  await opened.transaction(tx => {
    tx.put("message", "message_a", exactMessage());
    tx.put("receipt", "receipt_a", { schemaVersion: SCHEMA_VERSION, workspaceId: WS,
      messageId: "message_a", recipientParticipantId: "participant_a", state: "queued", updatedAt: NOW });
  }, { kinds: ["message", "receipt"] });
  const identityFile = path.join(root, "protocol.json");
  const identity = { ...JSON.parse(await readFile(identityFile)), storeVersion: 6 };
  await writeFile(identityFile, encode(identity));
  return { root, paths: opened.paths, clock, ids, identity, identityFile,
    options: { root, workspaceId: WS, clock, ids, allowMigration: true } };
}
const migrate = options => {
  assert.equal(typeof storage.migrateFilesystemStore, "function", "explicit migration implementation missing");
  return storage.migrateFilesystemStore(options);
};
const primaryBytes = async root => Promise.all(["message/message_a", "receipt/receipt_a"]
  .map(name => readFile(path.join(root, "state", name + ".json"))));

test("migration preserves records and initialized identity", async t => {
  const f = await legacy(t), before = await primaryBytes(f.root);
  await assert.rejects(storage.openFilesystemStore(f.options), error =>
    error.code === EXIT.DATA && /doctor --migrate-store/.test(error.message));
  assert.deepEqual(await migrate(f.options), { fromVersion: 6, toVersion: 7, migrated: true });
  const after = JSON.parse(await readFile(f.identityFile));
  assert.deepEqual(after, { ...f.identity, storeVersion: 7 });
  assert.deepEqual(await primaryBytes(f.root), before);
  const opened = await storage.openFilesystemStore(f.options);
  assert.deepEqual(await opened.transaction(tx => tx.lookup("messageByClientKey", [WS, "participant_a", "client_a"]),
    { kinds: ["message"], exactKinds: ["message"] }), ["message_a"]);
  assert.deepEqual(await migrate(f.options), { fromVersion: 7, toVersion: 7, migrated: false });
  assert.deepEqual(await primaryBytes(f.root), before);
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
      phase === "after-store-version-switch" ? 7 : 6);
    const result = await migrate(f.options);
    assert.equal(result.toVersion, 7);
    assert.equal(result.migrated, phase !== "after-store-version-switch");
    assert.deepEqual(await primaryBytes(f.root), before);
  });
}

test("migration refuses absent opt-in, deadlines and invalid identity without switching", async t => {
  const f = await legacy(t);
  await assert.rejects(migrate({ ...f.options, allowMigration: false }), { code: EXIT.USAGE });
  await assert.rejects(migrate({ ...f.options, deadlineAt: 0 }), { code: EXIT.CONFLICT });
  for (const identity of [{ ...f.identity, storeVersion: 8 }, { ...f.identity, workspaceId: "workspace_other" },
    { ...f.identity, initialisedAt: null }, { ...f.identity, extra: "unknown" }]) {
    const before = encode(identity); await writeFile(f.identityFile, before);
    await assert.rejects(migrate(f.options), { code: EXIT.DATA });
    assert.deepEqual(await readFile(f.identityFile), before);
  }
});

test("migration refuses corrupt primary and verifies cache again on version seven", async t => {
  const f = await legacy(t), file = path.join(f.root, "state/message/message_a.json");
  const bytes = await readFile(file);
  await writeFile(file, "invalid primary bytes");
  await assert.rejects(migrate(f.options), { code: EXIT.DATA });
  assert.equal(JSON.parse(await readFile(f.identityFile)).storeVersion, 6);
  await writeFile(file, bytes); await migrate(f.options);
  const manifestFile = path.join(f.root, "indexes/v1/cache.json");
  await rm(manifestFile);
  assert.deepEqual(await migrate(f.options), { fromVersion: 7, toVersion: 7, migrated: false });
  assert.equal(JSON.parse(await readFile(manifestFile)).workspaceId, WS);
});
