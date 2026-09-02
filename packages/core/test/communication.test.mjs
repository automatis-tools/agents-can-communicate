import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-01T16:30:00.000Z";
const WORKSPACE = "workspace_conversations";

function makeService() {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  return { store, clock, ids,
    service: createCoordinationService({ store, clock, ids }) };
}

const opening = (participantId, overrides = {}) => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000, ...overrides });
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
const MESSAGE_FIELDS = ["artifacts", "body", "clientMessageId", "fromParticipantId",
  "fromSessionId", "handoff", "inReplyTo", "kind", "messageId", "obligation",
  "schemaVersion", "sentAt", "subject", "threadId", "toParticipantIds", "workspaceId"];
const direct = (session, overrides = {}) => ({ ...owner(session),
  clientMessageId: "client_direct", toParticipantIds: ["recipient"], kind: "decision",
  obligation: "acknowledge", subject: "Choose the seam", body: "Use the durable seam.",
  ...overrides });

async function trio(service) {
  const sender = await service.openSession(opening("sender"));
  const recipient = await service.openSession(opening("recipient"));
  const other = await service.openSession(opening("other"));
  return { sender, recipient, other };
}

test("each addressed recipient owns an independent queued receipt", async () => {
  const { service, store } = makeService();
  const { sender } = await trio(service);

  const message = await service.sendMessage(direct(sender, {
    toParticipantIds: ["recipient", "other"] }));
  const receipts = (await store.snapshot(WORKSPACE)).receipts
    .filter(receipt => receipt.messageId === message.messageId);

  assert.deepEqual(receipts.map(receipt => receipt.recipientParticipantId).sort(),
    ["other", "recipient"]);
  assert.deepEqual(receipts.map(receipt => receipt.state), ["queued", "queued"]);
});

test("one recipient cannot retrieve or acknowledge another recipient's receipt", async () => {
  const { service, store } = makeService();
  const { sender, recipient } = await trio(service);
  const message = await service.sendMessage(direct(sender, {
    toParticipantIds: ["recipient", "other"] }));

  await service.acknowledgeMessage({ ...owner(recipient), messageId: message.messageId });
  const receipts = (await store.snapshot(WORKSPACE)).receipts;

  assert.equal(receipts.find(item => item.recipientParticipantId === "recipient").state,
    "acknowledged");
  assert.equal(receipts.find(item => item.recipientParticipantId === "other").state,
    "queued");
  await assert.rejects(service.acknowledgeMessage({ ...owner(sender),
    messageId: message.messageId }), error => error.code === EXIT.CONFLICT);
});

test("successful offers are generation-bound and receipt states move only forward", async () => {
  const { service } = makeService();
  const { sender, recipient, other } = await trio(service);
  const message = await service.sendMessage(direct(sender));
  const offer = overrides => service.recordOfferSucceeded({ messageId: message.messageId,
    recipientParticipantId: "recipient", targetSessionId: recipient.sessionId,
    targetGeneration: recipient.generation, transport: "test-transport", adapterId: "test",
    clientVersion: "1.0.0", ...overrides });

  await assert.rejects(offer({ targetSessionId: other.sessionId,
    targetGeneration: other.generation }), error => error.code === EXIT.CONFLICT);
  assert.equal((await offer()).state, "offered");
  assert.equal((await service.readInbox({ ...owner(recipient),
    messageId: message.messageId }))[0].receipt.state, "retrieved");
  assert.equal((await offer()).state, "retrieved");
  assert.equal((await offer({ targetSessionId: other.sessionId,
    targetGeneration: other.generation })).state, "retrieved");
});

test("a failed offer records only a safe event and leaves the receipt queued", async () => {
  const { service, store } = makeService();
  const { sender } = await trio(service);
  const message = await service.sendMessage(direct(sender));

  const event = await service.recordOfferFailed({ messageId: message.messageId,
    recipientParticipantId: "recipient", actorSessionId: sender.sessionId,
    transport: "test-transport", adapterId: "test", clientVersion: "1.0.0",
    safeErrorCode: "transport_error" });

  assert.equal(event.type, "message.offer_failed");
  assert.equal((await store.snapshot(WORKSPACE)).receipts[0].state, "queued");
  await assert.rejects(service.recordOfferFailed({ messageId: message.messageId,
    recipientParticipantId: "recipient", actorSessionId: sender.sessionId,
    transport: "test-transport", adapterId: "test", clientVersion: "1.0.0",
    safeErrorCode: "peer said: secret token" }), error => error.code === EXIT.DATA);
});

test("a room receipt is inbox-only and cannot become a live offer", async () => {
  const { service } = makeService();
  const { sender, recipient } = await trio(service);
  const room = await service.sendMessage({ ...owner(sender),
    clientMessageId: "client_room_note", toParticipantIds: [], kind: "note",
    obligation: "none", subject: "Room", body: "Inbox history for current peers." });

  await assert.rejects(service.recordOfferSucceeded({ messageId: room.messageId,
    recipientParticipantId: "recipient", targetSessionId: recipient.sessionId,
    targetGeneration: recipient.generation, transport: "test-transport", adapterId: "test",
    clientVersion: "1.0.0" }), error => error.code === EXIT.CONFLICT && /room/.test(error.message));
  await assert.rejects(service.recordOfferFailed({ messageId: room.messageId,
    recipientParticipantId: "recipient", actorSessionId: sender.sessionId,
    transport: "test-transport", adapterId: "test", clientVersion: "1.0.0",
    safeErrorCode: "transport_error" }),
  error => error.code === EXIT.CONFLICT && /room/.test(error.message));
});

test("finish atomically records an addressed handoff, releases claims, and closes presence",
  async () => {
    const { service, store } = makeService();
    const { sender } = await trio(service);
    const claim = await service.acquireClaim({ ...owner(sender), resource: "file:src/**",
      reason: "editing" });

    const result = await service.finishSession({ ...owner(sender),
      clientMessageId: "client_finish", toParticipantId: "recipient",
      goal: "complete the durable seam", status: "partial", completed: ["threading"],
      remaining: ["router"], blockers: ["capture"], verification: [], artifacts: [] });

    assert.equal(result.message.kind, "handoff");
    assert.equal(result.message.obligation, "acknowledge");
    assert.deepEqual(result.message.toParticipantIds, ["recipient"]);
    assert.deepEqual(result.message.handoff, { status: "partial", completed: ["threading"],
      remaining: ["router"], blockers: ["capture"], verification: [] });
    assert.deepEqual(Object.keys(result.message).sort(), MESSAGE_FIELDS);
    assert.deepEqual(result.releasedClaims, [{ claimId: claim.claimId,
      resource: "file:src/**", mode: "exclusive" }]);
    assert.equal(result.session.state, "closed");
    const snapshot = await store.snapshot(WORKSPACE);
    assert.deepEqual(snapshot.claims, []);
    assert.equal(snapshot.sessions.find(item => item.sessionId === sender.sessionId).state,
      "closed");
  });

test("finish without a successor creates a room handoff with no obligation", async () => {
  const { service, store } = makeService();
  const { sender } = await trio(service);

  const result = await service.finishSession({ ...owner(sender),
    clientMessageId: "client_room_finish", goal: "leave durable context",
    completed: [], remaining: [], blockers: [], verification: [], artifacts: [] });

  assert.deepEqual(result.message.toParticipantIds, []);
  assert.equal(result.message.obligation, "none");
  assert.equal(result.message.handoff.status, "partial");
  assert.deepEqual((await store.snapshot(WORKSPACE)).receipts
    .map(receipt => receipt.recipientParticipantId).sort(), ["other", "recipient"]);
});

test("finish retry data is absent from every public read surface", async () => {
  const { service } = makeService();
  const { sender, recipient } = await trio(service);
  const secretReason = "PRIVATE-RETRY-REASON";
  await service.acquireClaim({ ...owner(sender), resource: "file:private-retry.mjs",
    reason: secretReason });

  const result = await service.finishSession({ ...owner(sender),
    clientMessageId: "client_public_finish", toParticipantId: "recipient",
    goal: "public handoff", completed: [], remaining: [], blockers: [],
    verification: [], artifacts: [] });
  const pending = await service.pendingMessages({ participantId: "recipient" });
  const delta = await service.sync({ ...owner(recipient), scope: "delta" });
  const full = await service.sync({ ...owner(recipient), scope: "full" });
  const inbox = await service.readInbox({ ...owner(recipient),
    messageId: result.message.messageId });
  const status = await service.collectStatus({ participantId: "recipient", all: true });

  for (const message of [result.message, pending[0], inbox[0].message,
    full.snapshot.messages[0]]) {
    assert.deepEqual(Object.keys(message).sort(), MESSAGE_FIELDS);
  }
  const exposed = JSON.stringify({ result, pending, delta, full, inbox, status });
  assert.equal(exposed.includes('"extensions"'), false);
  assert.equal(exposed.includes(secretReason), false);
});

test("addressed finish response-loss retry returns the prior outcome without new writes",
  async () => {
    const { service, store, clock, ids } = makeService();
    const { sender } = await trio(service);
    await service.acquireClaim({ ...owner(sender), resource: "file:src/**",
      reason: "editing" });
    const input = { ...owner(sender), clientMessageId: "client_finish_retry",
      toParticipantId: "recipient", goal: "complete the durable seam", status: "partial",
      completed: ["threading"], remaining: ["router"], blockers: [], verification: [],
      artifacts: [] };
    const first = await service.finishSession(input);
    const beforeSnapshot = await store.snapshot(WORKSPACE);
    const beforeEvents = await store.eventsSince(WORKSPACE, null, 100);
    clock.advance(5_000);

    const restarted = createCoordinationService({ store, clock, ids });
    const retried = await restarted.finishSession(input);
    const afterSnapshot = await store.snapshot(WORKSPACE);
    const afterEvents = await store.eventsSince(WORKSPACE, null, 100);

    assert.deepEqual(retried, first);
    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(afterEvents.events.length, beforeEvents.events.length);
    await assert.rejects(restarted.finishSession({ ...input, remaining: ["different"] }),
      error => error.code === EXIT.CONFLICT && /clientMessageId/.test(error.message));
  });

test("room finish retry preserves its original audience snapshot", async () => {
  const { service, store, clock, ids } = makeService();
  const { sender } = await trio(service);
  const input = { ...owner(sender), clientMessageId: "client_room_finish_retry",
    goal: "leave durable context", completed: [], remaining: [], blockers: [],
    verification: [], artifacts: [] };
  const first = await service.finishSession(input);
  await service.openSession(opening("later"));
  const before = await store.eventsSince(WORKSPACE, null, 100);
  clock.advance(5_000);

  const restarted = createCoordinationService({ store, clock, ids });
  const retried = await restarted.finishSession(input);
  const after = await store.eventsSince(WORKSPACE, null, 100);

  assert.deepEqual(retried, first);
  assert.equal(after.events.length, before.events.length);
  const snapshot = await store.snapshot(WORKSPACE);
  assert.equal(snapshot.messages.length, 1);
  assert.deepEqual(snapshot.receipts.map(item => item.recipientParticipantId).sort(),
    ["other", "recipient"]);
});

test("a finish retry key cannot cross a replacement session generation", async () => {
  const { service } = makeService();
  const { sender } = await trio(service);
  const input = { ...owner(sender), clientMessageId: "client_finish_generation",
    toParticipantId: "recipient", goal: "generation bound", completed: [], remaining: [],
    blockers: [], verification: [], artifacts: [] };
  await service.finishSession(input);
  const replacement = await service.openSession(opening("sender",
    { sessionId: sender.sessionId }));

  await assert.rejects(service.finishSession({ ...input, ...owner(replacement) }),
    error => error.code === EXIT.CONFLICT && /generation/.test(error.message));
});
