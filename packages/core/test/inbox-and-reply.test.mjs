import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const WORKSPACE = "workspace_inbox";

function makeService() {
  const clock = createFakeClock("2026-08-31T12:00:00.000Z");
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  return { store, service: createCoordinationService({ store, clock, ids }) };
}

const opening = participantId => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000 });

async function pair(service) {
  const sender = await service.openSession(opening("sender"));
  const recipient = await service.openSession(opening("recipient"));
  return { sender, recipient };
}

const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

test("inbox returns one addressed message and marks it seen without a workspace dump",
  async () => {
    const { service, store } = makeService();
    const { sender, recipient } = await pair(service);
    const message = await service.sendMessage({ ...owner(sender),
      toParticipantIds: ["recipient"], type: "question", subject: "Contract",
      body: "Which fields are required?", requiresAck: true });

    const result = await service.readInbox({ ...owner(recipient), messageId: message.messageId });

    assert.deepEqual(result.map(item => item.message.messageId), [message.messageId]);
    assert.equal(result[0].receipt.state, "seen");
    assert.deepEqual(Object.keys(result[0]).sort(), ["message", "receipt"]);
    const receipt = (await store.snapshot(WORKSPACE, { kinds: ["receipt"] })).receipts[0];
    assert.equal(receipt.state, "seen");
  });

test("inbox can recover an injected direct request after compaction", async () => {
  const { service } = makeService();
  const { sender, recipient } = await pair(service);
  const message = await service.sendMessage({ ...owner(sender),
    toParticipantIds: ["recipient"], type: "question", subject: "Resume",
    body: "Can you answer after compacting?", requiresAck: true });
  await service.markDelivery({ ...owner(recipient), messageId: message.messageId,
    state: "injected" });

  const result = await service.readInbox({ ...owner(recipient) });

  assert.deepEqual(result.map(item => item.message.messageId), [message.messageId]);
  assert.equal(result[0].receipt.state, "seen");
});

test("an injected note is quiet in the list but recoverable by its exact id", async () => {
  const { service } = makeService();
  const { sender, recipient } = await pair(service);
  const note = await service.sendMessage({ ...owner(sender),
    toParticipantIds: ["recipient"], type: "note", subject: "Decision breadcrumb",
    body: "The compacted context still needs this body.", requiresAck: false });
  await service.markDelivery({ ...owner(recipient), messageId: note.messageId,
    state: "injected" });

  assert.deepEqual(await service.readInbox({ ...owner(recipient) }), []);
  const exact = await service.readInbox({ ...owner(recipient), messageId: note.messageId });
  assert.equal(exact[0].message.body, "The compacted context still needs this body.");
  assert.equal(exact[0].receipt.state, "seen");
});

test("reply sends to the original participant and acknowledges the request atomically",
  async () => {
    const { service, store } = makeService();
    const { sender, recipient } = await pair(service);
    const request = await service.sendMessage({ ...owner(sender),
      toParticipantIds: ["recipient"], type: "question", subject: "Gate",
      body: "Can I proceed?", requiresAck: true });

    const result = await service.replyToMessage({ ...owner(recipient),
      messageId: request.messageId, body: "Yes, the gate is clear." });

    assert.equal(result.reply.inReplyTo, request.messageId);
    assert.deepEqual(result.reply.toParticipantIds, ["sender"]);
    assert.equal(result.receipt.state, "acknowledged");
    const snapshot = await store.snapshot(WORKSPACE, { kinds: ["message", "receipt"] });
    assert.equal(snapshot.messages.length, 2);
    assert.equal(snapshot.receipts
      .find(item => item.messageId === request.messageId).state, "acknowledged");
  });

test("another participant cannot read or reply to a message not addressed to it", async () => {
  const { service } = makeService();
  const { sender } = await pair(service);
  const stranger = await service.openSession(opening("stranger"));
  const message = await service.sendMessage({ ...owner(sender),
    toParticipantIds: ["recipient"], type: "question", subject: "Private routing",
    body: "For the intended peer", requiresAck: true });

  await assert.rejects(service.readInbox({ ...owner(stranger), messageId: message.messageId }),
    error => error.code === EXIT.CONFLICT);
  await assert.rejects(service.replyToMessage({ ...owner(stranger),
    messageId: message.messageId, body: "intercepted" }),
  error => error.code === EXIT.CONFLICT);
});
