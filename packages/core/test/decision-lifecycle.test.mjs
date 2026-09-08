import assert from "node:assert/strict";
import test from "node:test";
import { EXIT } from "@agents-can-communicate/protocol";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const workspaceId = "workspace_decisions";
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
async function fixture() {
  const clock = createFakeClock("2026-08-01T12:00:00.000Z"), ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId });
  const service = createCoordinationService({ clock, ids, store });
  const open = participantId => service.openSession({ workspaceId, participantId,
    harness: "fixture", heartbeatCadenceMs: 30_000 });
  const author = await open("author"), reader = await open("reader"), peer = await open("peer");
  const send = (key, extra = {}) => service.sendMessage({ ...owner(author),
    clientMessageId: key.replaceAll(" ", "_"), kind: "decision", obligation: "acknowledge",
    subject: "Port choice", body: key, toParticipantIds: ["reader"], ...extra });
  const history = extra => service.sync({ scope: "history", ...extra });
  const exact = async id => (await history({ messageId: id })).items[0];
  return { clock, store, service, author, reader, peer, open, send, history, exact };
}

test("explicit peer replacement reaches offline recipients, retires attention, and preserves receipts/history", async () => {
  const f = await fixture();
  const old = await f.send("Use port 7011");
  const before = (await f.store.snapshot(workspaceId)).receipts;
  await f.service.closeSession(owner(f.reader));
  const replacement = await f.send("Use port 7319", { ...owner(f.peer),
    toParticipantIds: [], obligation: "none", supersedes: [old.messageId] });
  assert.deepEqual(replacement.decisionChange, { action: "replace", messageIds: [old.messageId] });
  assert.deepEqual(replacement.toParticipantIds, ["author", "reader"]);
  const reader = await f.open("reader");
  const pending = await f.service.nextTurnDelivery({ participantId: "reader" });
  assert.deepEqual(pending.queuedMessages.map(m => m.messageId), [replacement.messageId]);
  assert.equal(pending.queuedMessages[0].decisionStatus.state, "current");
  const status = await f.service.sync(owner(reader));
  assert.equal(status.attention.some(item => item.sourceId === old.messageId), false);
  const after = (await f.store.snapshot(workspaceId)).receipts;
  assert.deepEqual(after.filter(r => r.messageId === old.messageId), before);
  assert.equal((await f.exact(old.messageId)).body, "Use port 7011");
  assert.equal((await f.exact(old.messageId)).decisionStatus.state, "superseded");
  assert.equal((await f.exact(old.messageId)).decisionStatus.currentMessageId, replacement.messageId);
  const inbox = await f.service.listInbox(owner(reader));
  assert.equal(inbox.items.some(i => i.message.messageId === old.messageId), false);
  const [read] = await f.service.readInbox({ ...owner(reader), messageId: old.messageId });
  assert.equal(read.message.decisionStatus.state, "superseded");
  assert.equal(read.receipt.state, "retrieved", "a supersession must never forge acknowledgement");
});

test("forks remain visible across equal clocks, merge explicitly, withdraw and reinstate without erasing history", async () => {
  const f = await fixture();
  const root = await f.send("root");
  const a = await f.send("branch-a", { supersedes: [root.messageId] });
  const b = await f.send("branch-b", { ...owner(f.peer), supersedes: [root.messageId] });
  const current = await f.history({ kind: "decision", current: true, limit: 1 });
  assert.equal(current.items.length, 1);
  assert.ok(current.nextCursor);
  const next = await f.history({ kind: "decision", current: true, cursor: current.nextCursor });
  assert.deepEqual(new Set([...current.items, ...next.items].map(m => m.messageId)),
    new Set([a.messageId, b.messageId]));
  for (const m of [...current.items, ...next.items]) {
    assert.equal(m.decisionStatus.conflicted, true);
    assert.equal(m.decisionStatus.headCount, 2);
    assert.equal(m.decisionStatus.currentMessageId, null);
  }
  const merge = await f.send("merge", { supersedes: [a.messageId, b.messageId] });
  assert.equal((await f.exact(root.messageId)).decisionStatus.conflicted, false);
  assert.equal((await f.exact(root.messageId)).decisionStatus.currentMessageId, merge.messageId);
  const withdrawal = await f.send("No port selected", { withdraws: [merge.messageId] });
  assert.equal((await f.exact(merge.messageId)).decisionStatus.state, "withdrawn");
  const heads = await f.history({ kind: "decision", current: true });
  assert.deepEqual(heads.items.map(m => m.messageId), [withdrawal.messageId]);
  assert.equal(heads.items[0].decisionStatus.state, "withdrawn");
  assert.equal(heads.items[0].decisionStatus.isHead, true);
  const restored = await f.send("Choose again", { supersedes: [withdrawal.messageId] });
  assert.equal((await f.exact(restored.messageId)).decisionStatus.state, "current");
  assert.equal((await f.history({ kind: "decision" })).items.length, 6);
});

test("invalid links roll back; link sets participate in idempotency and ownership checks", async () => {
  const f = await fixture();
  const a = await f.send("a"), b = await f.send("b");
  const note = await f.send("note", { kind: "note", obligation: "none" });
  const before = await f.store.snapshot(workspaceId);
  const events = await f.store.eventsSince(workspaceId, null, 500);
  for (const extra of [{ supersedes: [] }, { supersedes: "message_bad" },
    { supersedes: [a.messageId, a.messageId] }, { supersedes: ["message_missing"] },
    { supersedes: [note.messageId] }, { supersedes: [a.messageId], withdraws: [b.messageId] },
    { supersedes: Array.from({ length: 17 }, (_, i) => `message_${i}`) },
    { decisionChange: { action: "replace", messageIds: ["message_missing"] } },
    { kind: "note", obligation: "none", supersedes: [a.messageId] }]) {
    await assert.rejects(f.send("invalid", extra), e => [EXIT.DATA, EXIT.USAGE].includes(e.code));
  }
  assert.deepEqual(await f.store.snapshot(workspaceId), before);
  assert.deepEqual(await f.store.eventsSince(workspaceId, null, 500), events);
  await assert.rejects(f.send("stale", { generation: "stale", supersedes: [a.messageId] }),
    e => e.code === EXIT.CONFLICT);
  const change = await f.send("same-key", { supersedes: [a.messageId, b.messageId] });
  const saved = await f.store.snapshot(workspaceId);
  assert.deepEqual(await f.send("same-key", { supersedes: [b.messageId, a.messageId] }), change);
  await assert.rejects(f.send("same-key", { supersedes: [a.messageId] }), e => e.code === EXIT.CONFLICT);
  await assert.rejects(f.send("same-key", { withdraws: [a.messageId, b.messageId] }), e => e.code === EXIT.CONFLICT);
  assert.deepEqual(await f.store.snapshot(workspaceId), saved);
});

test("text and age do not retire unrelated obligations; current controls cannot widen a read", async () => {
  const f = await fixture();
  const old = await f.send("old");
  f.clock.advance(365 * 86_400_000);
  await f.send(`This replaces ${old.messageId}`);
  const request = await f.send("request", { kind: "request", obligation: "reply" });
  const status = await f.service.sync(owner(f.reader));
  for (const id of [old.messageId, request.messageId]) {
    assert.ok(status.attention.some(item => item.sourceId === id));
  }
  assert.equal((await f.exact(old.messageId)).decisionStatus.state, "current");
  for (const input of [{ current: true }, { scope: "full", current: true },
    { scope: "history", current: true }, { scope: "history", kind: "note", current: true },
    { scope: "history", kind: "decision", current: "true" },
    { scope: "history", messageId: old.messageId, current: true }]) {
    await assert.rejects(f.service.sync(input), e => e.code === EXIT.USAGE);
  }
});
