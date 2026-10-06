import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "../src/store.mjs";
import { readActiveJournal } from "../src/active-journal.mjs";
import { createMemoryStore, createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { exactMessage, EXACT_NOW as NOW, EXACT_WORKSPACE as WS } from "../../../tests/helpers/exact-transaction-contract.mjs";

const key = client => [WS, "participant_a", client];
const exact = { kinds: ["message", "receipt"], exactKinds: ["message", "receipt"] };
const lookup = (store, client = "client_a") => store.transaction(
  tx => tx.lookup("messageByClientKey", key(client)), exact);
const seed = (store, id = "message_a", client = "client_a") => store.transaction(
  tx => tx.put("message", id, exactMessage({ messageId: id, threadId: id, clientMessageId: client })),
  { kinds: ["message"] });
const event = id => ({ schemaVersion: SCHEMA_VERSION, eventId: id, workspaceId: WS,
  actorSessionId: "session_a", type: "message.recorded", occurredAt: NOW, payload: {} });
async function fixture(t, failAt) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-index-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openFilesystemStore({ root, workspaceId: WS,
    clock: createFakeClock(NOW), ids: createFakeIds(), failAt });
  return { root, store, manifestFile: path.join(root, "indexes/v1/cache.json") };
}

test("generic indexed writes advance authority", async t => {
  const { root, store } = await fixture(t);
  let before = await readActiveJournal(store.paths, root);
  await seed(store);
  let after = await readActiveJournal(store.paths, root);
  assert.notEqual(after.generation, before.generation, "single message writes must fence indexed negatives");
  before = after;
  await store.transaction(tx => tx.put("receipt", "receipt_a", { schemaVersion: SCHEMA_VERSION,
    workspaceId: WS, messageId: "message_a", recipientParticipantId: "participant_a", state: "queued", updatedAt: NOW }),
  { kinds: ["receipt"] });
  after = await readActiveJournal(store.paths, root);
  assert.notEqual(after.generation, before.generation);
  await store.transaction(tx => tx.put("session", "session_a", { schemaVersion: SCHEMA_VERSION,
    workspaceId: WS, sessionId: "session_a", participantId: "participant_a", generation: "generation_a",
    harness: "cli", state: "open", parentSessionId: null, checkoutRoot: null, branch: null, pid: null,
    enforcement: "advisory", lifecycle: "manual", heartbeatCadenceMs: 30_000, startedAt: NOW, heartbeatAt: NOW }),
  { kinds: ["session"] });
  assert.equal((await readActiveJournal(store.paths, root)).generation, after.generation);
  assert.deepEqual(await lookup(store), ["message_a"]);
  await store.transaction(async tx => {
    const record = await tx.load("message", "message_a");
    tx.put("message", "message_a", { ...record, clientMessageId: "client_new" }, tx.generationOf("message", "message_a"));
  }, exact);
  assert.deepEqual(await lookup(store, "client_new"), ["message_a"]);
  assert.deepEqual(await lookup(store), []);
  assert.deepEqual(await store.transaction(tx => tx.lookup("receiptsByMessage", [WS, "message_a"]), exact), ["receipt_a"]);
});

for (const backend of ["memory", "filesystem"]) {
  test(`${backend}: staged lookup and rollback`, async t => {
    const store = backend === "filesystem" ? (await fixture(t)).store : createMemoryStore({
      workspaceId: WS, clock: createFakeClock(NOW), ids: createFakeIds() });
    await seed(store);
    assert.deepEqual(await lookup(store), ["message_a"]);
    const boom = new Error("rollback indexed staging");
    await assert.rejects(store.transaction(async tx => {
      await tx.load("message", "message_a");
      tx.put("message", "message_a", exactMessage({ clientMessageId: "client_new" }), tx.generationOf("message", "message_a"));
      assert.deepEqual(await tx.lookup("messageByClientKey", key("client_a")), []);
      assert.deepEqual(await tx.lookup("messageByClientKey", key("client_new")), ["message_a"]);
      tx.remove("message", "message_a", tx.generationOf("message", "message_a"));
      assert.deepEqual(await tx.lookup("messageByClientKey", key("client_new")), []);
      throw boom;
    }, exact), boom);
    assert.deepEqual(await lookup(store), ["message_a"]);
    assert.deepEqual(await lookup(store, "client_new"), []);
    await assert.rejects(store.transaction(tx => tx.lookup("messageByClientKey", key("client_a")),
      { kinds: ["session"] }), { code: EXIT.DATA });
    await store.transaction(async tx => {
      await tx.lookup("messageByClientKey", key("client_a"));
      assert.throws(() => tx.get("message", "message_a"), { code: EXIT.DATA },
        "a lookup must not waive an explicit load");
    }, exact);
  });
}

test("cache survives unrelated journal changes without reading the backlog", async t => {
  const { store, root } = await fixture(t);
  await seed(store); await seed(store, "message_unrelated", "client_unrelated");
  assert.deepEqual(await lookup(store), ["message_a"]);
  await writeFile(path.join(root, "state/message/message_unrelated.json"), "invalid primary bytes");
  await store.transaction(tx => {
    tx.put("intent", "session_a", { schemaVersion: SCHEMA_VERSION, workspaceId: WS, sessionId: "session_a",
      summary: "working", mode: "edit", resourceHints: [], state: "active", updatedAt: NOW });
    tx.append({ ...event("event_unrelated"), type: "intent.published" });
  }, { kinds: ["intent"] });
  assert.deepEqual(await lookup(store), ["message_a"], "a carried cache must not scan a different message");
  await assert.rejects(lookup(store, "client_unrelated"), { code: EXIT.DATA }, "selected corrupt primary must still fail");
});

for (const phase of ["after-primary-commit", "after-index-pages", "before-index-manifest"]) {
  test(`cache faults preserve primary outcomes at ${phase}`, async t => {
    let armed = false;
    const { store } = await fixture(t, seen => {
      if (armed && seen === phase) { armed = false; throw new Error("cache seam failure"); }
    });
    await seed(store); await lookup(store); armed = true;
    assert.equal(await store.transaction(tx => {
      tx.put("message", "message_b", exactMessage({ messageId: "message_b", threadId: "message_b", clientMessageId: "client_b" }));
      tx.append(event("event_b")); return "recorded";
    }, { kinds: ["message"] }), "recorded");
    assert.equal((await store.eventsSince(WS, null, 10)).events.length, 1);
    assert.equal((await store.stateRecord(WS, "message", "message_b")).clientMessageId, "client_b");
    assert.equal(store.indexDiagnostics().at(-1)?.code, "index_unavailable");
    assert.deepEqual(await lookup(store, "client_b"), ["message_b"]);
  });
}

test("wrong epochs, workspace and corrupt pages rebuild from verified primary", async t => {
  const { store, root, manifestFile } = await fixture(t);
  await seed(store); await lookup(store);
  const stale = await readFile(manifestFile);
  await seed(store, "message_b", "client_b");
  await writeFile(manifestFile, stale);
  assert.deepEqual(await lookup(store, "client_b"), ["message_b"],
    "an old negative is invalid after an indexed writer advances the epoch");
  for (const change of [manifest => ({ ...manifest, journalGeneration: "0000000000000000" }),
    manifest => ({ ...manifest, workspaceId: "workspace_elsewhere" })]) {
    const manifest = JSON.parse(await readFile(manifestFile));
    await writeFile(manifestFile, JSON.stringify(change(manifest)));
    assert.deepEqual(await lookup(store), ["message_a"]);
    assert.equal(store.indexDiagnostics().at(-1)?.code, "index_rebuilt");
  }
  const manifest = JSON.parse(await readFile(manifestFile));
  await writeFile(path.join(root, "indexes/v1/pages", manifest.roots.messageByClientKey + ".json"), "corrupt cache");
  assert.deepEqual(await lookup(store), ["message_a"]);
  assert.equal(store.indexDiagnostics().at(-1)?.code, "index_rebuilt");
});

test("unsafe cache directories allow verified fallback without writes through a junction", async t => {
  const { store, root } = await fixture(t);
  await seed(store); await lookup(store);
  const outside = path.join(root, "outside"); await mkdir(outside);
  await rm(path.join(root, "indexes"), { recursive: true });
  await symlink(outside, path.join(root, "indexes"), "junction");
  await seed(store, "message_b", "client_b");
  assert.deepEqual(await lookup(store, "client_b"), ["message_b"]);
  assert.equal(store.indexDiagnostics().at(-1)?.code, "index_unavailable");
  await assert.rejects(readFile(path.join(outside, "v1/cache.json")), { code: "ENOENT" });
  // Fallback is not a corruption catch around authoritative records.
  await writeFile(path.join(root, "state/message/message_a.json"), "corrupt primary");
  await assert.rejects(lookup(store), { code: EXIT.DATA });
});

test("a retained handle recovers a decided writer before trusting its old cache", async t => {
  let armed = false;
  const { store } = await fixture(t, phase => {
    if (armed && phase === "after-journal") { armed = false; throw new Error("decided writer died"); }
  });
  await seed(store); await lookup(store); armed = true;
  await assert.rejects(seed(store, "message_b", "client_b"), /decided writer died/);
  assert.deepEqual(await lookup(store, "client_b"), ["message_b"]);
  assert.equal((await store.stateRecord(WS, "message", "message_b")).clientMessageId, "client_b");
});
