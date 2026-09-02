import assert from "node:assert/strict";
import test from "node:test";

import { EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { receiptId } from "../src/conversations.mjs";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const WORKSPACE = "workspace_idempotency";

function makeService() {
  const clock = createFakeClock("2026-09-01T18:00:00.000Z");
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  return { store, service: createCoordinationService({ store, clock, ids }) };
}

const opening = (participantId, overrides = {}) => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000, ...overrides });
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
const input = session => ({ ...owner(session), clientMessageId: "client_same",
  toParticipantIds: ["recipient"], kind: "question", obligation: "reply",
  subject: "Which seam?", body: "Choose one durable seam.", inReplyTo: null,
  artifacts: [], handoff: null });

async function pair(service) {
  const sender = await service.openSession(opening("sender"));
  const recipient = await service.openSession(opening("recipient"));
  return { sender, recipient };
}

test("same participant and clientMessageId retry returns the one original message", async () => {
  const { service, store } = makeService();
  const { sender } = await pair(service);

  const first = await service.sendMessage(input(sender));
  const retried = await service.sendMessage({ ...input(sender) });

  assert.equal(retried.messageId, first.messageId);
  assert.equal((await store.snapshot(WORKSPACE)).messages.length, 1);
});

test("idempotency follows the participant across sessions", async () => {
  const { service, store } = makeService();
  const { sender } = await pair(service);
  const first = await service.sendMessage(input(sender));
  const continuation = await service.openSession(opening("sender"));

  const retried = await service.sendMessage(input(continuation));

  assert.equal(retried.messageId, first.messageId);
  assert.equal(retried.fromSessionId, sender.sessionId);
  assert.equal((await store.snapshot(WORKSPACE)).messages.length, 1);
});

test("reusing clientMessageId with different logical content conflicts", async () => {
  const { service } = makeService();
  const { sender } = await pair(service);
  await service.sendMessage(input(sender));

  await assert.rejects(service.sendMessage({ ...input(sender), body: "different" }),
    error => error.code === EXIT.CONFLICT && /clientMessageId/.test(error.message));
});

test("idempotency compares the workspace, participant, and client key as a tuple", async () => {
  const { service, store } = makeService();
  const firstSender = await service.openSession(opening("a--b"));
  await service.openSession(opening("recipient"));
  const secondSender = await service.openSession(opening("a"));
  const message = session => ({ ...owner(session), toParticipantIds: ["recipient"],
    kind: "note", obligation: "none", subject: "Distinct sender", body: "Same body." });

  const first = await service.sendMessage({ ...message(firstSender), clientMessageId: "c" });
  const second = await service.sendMessage({ ...message(secondSender),
    clientMessageId: "b--c" });

  assert.notEqual(second.messageId, first.messageId);
  assert.deepEqual((await store.snapshot(WORKSPACE)).messages
    .map(item => [item.fromParticipantId, item.clientMessageId]),
  [["a--b", "c"], ["a", "b--c"]]);
});

test("receipt storage keys are fixed-size portable encodings of the recipient tuple", () => {
  const left = receiptId("message_a--b", "c");
  const right = receiptId("message_a", "b--c");
  const longest = receiptId(`m${"x".repeat(199)}`, `p${"y".repeat(199)}`);

  assert.notEqual(left, right);
  assert.equal(left.length, right.length);
  assert.equal(left.length, longest.length);
  assert.doesNotThrow(() => assertPortableId(left, "receipt storage key"));
  assert.doesNotThrow(() => assertPortableId(longest, "receipt storage key"));
});

test("a root uses its message id and an answer inherits the referenced thread", async () => {
  const { service } = makeService();
  const { sender, recipient } = await pair(service);
  const root = await service.sendMessage(input(sender));

  const answer = await service.sendMessage({ ...owner(recipient),
    clientMessageId: "client_answer", toParticipantIds: ["sender"], kind: "answer",
    obligation: "none", subject: "Re: Which seam?", body: "The durable one.",
    inReplyTo: root.messageId, artifacts: [], handoff: null });

  assert.equal(root.threadId, root.messageId);
  assert.equal(root.inReplyTo, null);
  assert.equal(answer.threadId, root.messageId);
  assert.equal(answer.inReplyTo, root.messageId);
});

test("a room message snapshots currently open peer participants once", async () => {
  const { service, store } = makeService();
  const sender = await service.openSession(opening("sender"));
  await service.openSession(opening("recipient"));
  await service.openSession(opening("recipient"));
  const gone = await service.openSession(opening("gone"));
  await service.closeSession(owner(gone));

  const room = await service.sendMessage({ ...owner(sender), clientMessageId: "client_room",
    toParticipantIds: [], kind: "note", obligation: "none", subject: "Room note",
    body: "For peers here now.", inReplyTo: null, artifacts: [], handoff: null });
  await service.openSession(opening("later"));

  const snapshot = await store.snapshot(WORKSPACE);
  assert.deepEqual(room.toParticipantIds, []);
  assert.deepEqual(snapshot.receipts.map(item => item.recipientParticipantId), ["recipient"]);
  const event = (await store.eventsSince(WORKSPACE, null, 100)).events
    .find(item => item.type === "message.recorded" && item.payload.messageId === room.messageId);
  assert.deepEqual(event.payload.recipientParticipantIds, ["recipient"]);
});

test("addressing an unknown participant fails without recording anything", async () => {
  const { service, store } = makeService();
  const { sender } = await pair(service);

  await assert.rejects(service.sendMessage({ ...input(sender), toParticipantIds: ["missing"] }),
    error => error.code === EXIT.DATA && /no participant/.test(error.message));
  assert.deepEqual((await store.snapshot(WORKSPACE)).messages, []);
});
