import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { computeAttention } from "../src/attention.mjs";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

// Withdrawing a pending question or request (#145). The recipient that has not
// answered stops owing an answer, sees why, and an older ACC sharing the store
// stops showing the question too - which is why the receipt is closed rather
// than left for a new rule that only this version knows.

const WORKSPACE = "workspace_withdraw";

function fixture() {
  const clock = createFakeClock("2026-11-25T06:00:00.000Z");
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  return { clock, store, service: createCoordinationService({ store, clock, ids }) };
}

const opening = participantId => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000 });
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

async function room(service) {
  return { asker: await service.openSession(opening("asker")),
    alice: await service.openSession(opening("alice")),
    bob: await service.openSession(opening("bob")) };
}

let key = 0;
const ask = (service, from, to, kind = "question") => service.sendMessage({ ...owner(from),
  clientMessageId: `client_${key += 1}`, toParticipantIds: to, kind,
  obligation: kind === "note" ? "none" : "reply", subject: "Port choice", body: "Which port?" });

test("a withdrawal closes each pending receipt and tells each of those recipients why", async () => {
  const { service, store } = fixture();
  const { asker, alice, bob } = await room(service);
  const question = await ask(service, asker, ["alice", "bob"]);
  const attentionOf = async () => computeAttention(await store.snapshot(WORKSPACE), { session: alice,
    participantId: "alice", now: "2026-11-25T06:00:00.000Z", pidIsAlive: () => true })
    .filter(item => item.sourceId === question.messageId).map(item => item.kind);
  assert.deepEqual(await attentionOf(), ["reply_required"]);
  await service.replyToMessage({ ...owner(bob), messageId: question.messageId,
    clientMessageId: "client_bob_answer", body: "7319" });

  const result = await service.withdrawMessage({ ...owner(asker), messageId: question.messageId,
    clientMessageId: "client_withdraw", reason: "Settled in the design review." });

  assert.equal(result.created, true);
  assert.deepEqual(result.note.toParticipantIds, ["alice"], "bob had already answered");
  assert.equal(result.note.kind, "note");
  assert.equal(result.note.obligation, "none");
  assert.equal(result.note.inReplyTo, question.messageId);
  assert.equal(result.note.threadId, question.threadId);
  assert.equal(result.note.subject, "Withdrawn: Port choice");
  assert.equal(result.note.body, "Settled in the design review.");
  assert.deepEqual(result.note.extensions, { withdraws: question.messageId });
  assert.deepEqual(result.withdrawn.map(receipt => [receipt.recipientParticipantId, receipt.state,
    receipt.extensions.withdrawn.messageId]), [["alice", "acknowledged", result.note.messageId]]);

  const aliceInbox = await service.listInbox(owner(alice));
  assert.deepEqual(aliceInbox.items.map(item => item.message.subject), ["Withdrawn: Port choice"]);
  assert.deepEqual(await attentionOf(), []);
  const events = (await store.eventsSince(WORKSPACE, null, 1_000)).events
    .filter(event => event.type === "message.acknowledged" && event.payload.withdrawnBy);
  assert.deepEqual(events.map(event => event.payload.recipientParticipantId), ["alice"]);
});

test("an exact read still shows the withdrawn question, and its recipient may still reply", async () => {
  const { service } = fixture();
  const { asker, alice } = await room(service);
  const question = await ask(service, asker, ["alice"]);
  const { note } = await service.withdrawMessage({ ...owner(asker), messageId: question.messageId,
    reason: "No longer needed." });

  const [read] = await service.readInbox({ ...owner(alice), messageId: question.messageId });
  assert.equal(read.receipt.state, "acknowledged");
  assert.equal(read.receipt.extensions.withdrawn.messageId, note.messageId);
  const reply = await service.replyToMessage({ ...owner(alice), messageId: question.messageId,
    clientMessageId: "client_late", body: "Noted." });
  assert.equal(reply.receipt.state, "acknowledged");
});

test("a retry with the same client key returns the recorded withdrawal and changes nothing", async () => {
  const { service, store } = fixture();
  const { asker } = await room(service);
  const request = await ask(service, asker, ["alice"], "request");
  const input = { ...owner(asker), messageId: request.messageId, clientMessageId: "client_once",
    reason: "Done elsewhere." };
  const first = await service.withdrawMessage(input);
  const before = (await store.eventsSince(WORKSPACE, null, 1_000)).events.length;

  const again = await service.withdrawMessage(input);

  assert.equal(again.created, false);
  assert.equal(again.note.messageId, first.note.messageId);
  assert.deepEqual(again.withdrawn.map(receipt => receipt.recipientParticipantId), ["alice"]);
  assert.equal((await store.eventsSince(WORKSPACE, null, 1_000)).events.length, before);
});

test("withdrawal is refused for answered, foreign, unknown and other kinds of message", async () => {
  const { service } = fixture();
  const { asker, alice } = await room(service);
  const answered = await ask(service, asker, ["alice"]);
  await service.replyToMessage({ ...owner(alice), messageId: answered.messageId,
    clientMessageId: "client_answer", body: "Done." });
  const note = await ask(service, asker, ["alice"], "note");
  const theirs = await ask(service, alice, ["asker"]);
  const refuse = async (session, messageId, pattern) => assert.rejects(
    service.withdrawMessage({ ...owner(session), messageId, reason: "x" }),
    error => error.code === EXIT.CONFLICT && pattern.test(error.message));

  await refuse(asker, answered.messageId, /every recipient already answered/);
  await refuse(asker, note.messageId, /a note cannot be withdrawn/);
  await refuse(asker, theirs.messageId, /only the participant that sent a message/);
  await refuse(asker, "message_missing", /no message with that id/);
  await assert.rejects(service.withdrawMessage({ sessionId: asker.sessionId,
    generation: "generation_stale", messageId: answered.messageId, reason: "x" }),
  error => error.code === EXIT.CONFLICT);
});
