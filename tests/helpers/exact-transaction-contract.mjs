import assert from "node:assert/strict";
import test from "node:test";
import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

export const EXACT_WORKSPACE = "workspace_a";
export const EXACT_NOW = "2026-08-16T01:00:00.000Z";
export const exactMessage = (overrides = {}) => ({ schemaVersion: SCHEMA_VERSION,
  messageId: "message_a", threadId: "message_a", clientMessageId: "client_a",
  workspaceId: EXACT_WORKSPACE, fromParticipantId: "participant_a",
  fromSessionId: "session_a", toParticipantIds: [], kind: "note", obligation: "none",
  subject: "A record", body: "A real record.", inReplyTo: null, artifacts: [],
  handoff: null, sentAt: EXACT_NOW, ...overrides });
const exact = { kinds: ["message"], exactKinds: ["message"] };
const seed = store => store.transaction(tx => tx.put("message", "message_a", exactMessage()),
  { kinds: ["message"] });

// Omitting the explicit-load guards, pending-load cache, staged overlay,
// generation comparison, rollback or writer queue must break these cases.
export function runExactTransactionContract(name, makeStore) {
  test(`${name}: exact IDs must be loaded`, async t => {
    const store = await makeStore(t);
    await seed(store);
    for (const operation of [tx => tx.get("message", "message_a"),
      tx => tx.generationOf("message", "message_a"),
      tx => tx.put("message", "message_a", exactMessage()),
      tx => tx.remove("message", "message_a"), tx => tx.list("message")]) {
      await assert.rejects(store.transaction(operation, exact), { code: EXIT.DATA });
    }
    await assert.rejects(store.transaction(() => {}, { exactKinds: ["message"] }),
      { code: EXIT.DATA });
    await assert.rejects(store.transaction(() => {},
      { kinds: ["message"], exactKinds: ["session"] }), { code: EXIT.DATA });
    await store.transaction(async tx => {
      await assert.rejects(tx.load("session", "session_a"), { code: EXIT.DATA });
    }, exact);
    assert.equal((await store.snapshot(EXACT_WORKSPACE)).messages.length, 1);
  });

  test(`${name}: pending and staged loads share one view`, async t => {
    const store = await makeStore(t);
    await seed(store);
    await store.transaction(async tx => {
      const [first, second] = await Promise.all([
        tx.load("message", "message_a"), tx.load("message", "message_a")]);
      assert.strictEqual(first, second);
      const generation = tx.generationOf("message", "message_a");
      const changed = { ...first, subject: "Changed" };
      const next = tx.put("message", "message_a", changed, generation);
      assert.strictEqual(await tx.load("message", "message_a"), changed);
      assert.strictEqual(tx.get("message", "message_a"), changed);
      assert.equal(tx.generationOf("message", "message_a"), next);
      assert.throws(() => tx.put("message", "message_a", first, generation),
        { code: EXIT.CONFLICT });
      tx.remove("message", "message_a", next);
      assert.equal(await tx.load("message", "message_a"), null);
      assert.equal(tx.generationOf("message", "message_a"), null);
    }, exact);
    assert.deepEqual((await store.snapshot(EXACT_WORKSPACE)).messages, []);
  });

  test(`${name}: absent load and generation conflict`, async t => {
    const store = await makeStore(t);
    await store.transaction(async tx => {
      assert.equal(await tx.load("message", "message_a"), null);
      assert.equal(tx.generationOf("message", "message_a"), null);
      assert.throws(() => tx.put("message", "message_a", exactMessage(), "stale"),
        { code: EXIT.CONFLICT });
      const generation = tx.put("message", "message_a", exactMessage());
      tx.remove("message", "message_a", generation);
      assert.equal(await tx.load("message", "message_a"), null);
    }, exact);
    assert.deepEqual((await store.snapshot(EXACT_WORKSPACE)).messages, []);
  });

  test(`${name}: exact rollback publishes nothing`, async t => {
    const store = await makeStore(t);
    const boom = new Error("rollback after staging");
    await assert.rejects(store.transaction(async tx => {
      await tx.load("message", "message_a");
      tx.put("message", "message_a", exactMessage());
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: "event_a",
        workspaceId: EXACT_WORKSPACE, actorSessionId: "session_a",
        type: "message.recorded", occurredAt: EXACT_NOW, payload: {} });
      throw boom;
    }, exact), boom);
    assert.deepEqual((await store.snapshot(EXACT_WORKSPACE)).messages, []);
    assert.deepEqual((await store.eventsSince(EXACT_WORKSPACE, null, 10)).events, []);
  });

  test(`${name}: queued writer sees the committed exact record`, async t => {
    const store = await makeStore(t);
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const first = store.transaction(async tx => {
      await tx.load("message", "message_a");
      tx.put("message", "message_a", exactMessage({ subject: "Queued" }));
      started();
      await gate;
    }, exact);
    // Avoid a test hang if missing support rejects before reaching the gate.
    await Promise.race([entered, first]);
    const second = store.transaction(async tx => (await tx.load("message", "message_a"))?.subject,
      exact);
    second.catch(() => {});
    await Promise.resolve();
    release();
    const [, observed] = await Promise.all([first, second]);
    assert.equal(observed, "Queued");
  });

  test(`${name}: exact loads finish under their writer and refuse a retained handle`, async t => {
    const store = await makeStore(t);
    await seed(store);
    let retained, finished = false;
    await store.transaction(tx => {
      retained = tx;
      tx.load("message", "message_a").then(() => { finished = true; });
    }, exact);
    assert.equal(finished, true, "writer must wait for an already-started load");
    await assert.rejects(retained.load("message", "message_a"), { code: EXIT.DATA });
  });
}
