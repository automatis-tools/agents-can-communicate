import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const WORKSPACE = "workspace_inbox_v2";

function makeStore({ failAfterReplyWrite = () => false } = {}) {
  const clock = createFakeClock("2026-09-01T17:00:00.000Z");
  const ids = createFakeIds();
  const base = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const store = Object.freeze({ ...base,
    transaction(callback, options) {
      return base.transaction(tx => callback(Object.freeze({ ...tx,
        put(kind, id, record, generation) {
          const result = tx.put(kind, id, record, generation);
          if (kind === "message" && record.kind === "answer" && failAfterReplyWrite()) {
            throw new Error("injected failure after reply write");
          }
          return result;
        },
      })), options);
    },
  });
  return { base, clock, ids, store };
}

function makeService(options) {
  const fixture = makeStore(options);
  return { ...fixture,
    service: createCoordinationService({ store: fixture.store,
      clock: fixture.clock, ids: fixture.ids }) };
}

const opening = participantId => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000 });
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

async function pair(service) {
  const sender = await service.openSession(opening("sender"));
  const recipient = await service.openSession(opening("recipient"));
  return { sender, recipient };
}

async function question(service, sender, overrides = {}) {
  return service.sendMessage({ ...owner(sender), clientMessageId: "client_question",
    toParticipantIds: ["recipient"], kind: "question", obligation: "reply",
    subject: "Contract", body: "Which fields are stable?", ...overrides });
}

test("inbox retrieves only the selected participant-owned receipt", async () => {
  const { service, base } = makeService();
  const { sender, recipient } = await pair(service);
  const first = await question(service, sender);
  await service.sendMessage({ ...owner(sender), clientMessageId: "client_note",
    toParticipantIds: ["recipient"], kind: "note", obligation: "none",
    subject: "FYI", body: "Second message" });

  const result = await service.readInbox({ ...owner(recipient), messageId: first.messageId });

  assert.deepEqual(result.map(item => item.message.messageId), [first.messageId]);
  assert.equal(result[0].receipt.state, "retrieved");
  const receipts = (await base.snapshot(WORKSPACE)).receipts;
  assert.equal(receipts.find(item => item.messageId === first.messageId).state, "retrieved");
  assert.equal(receipts.find(item => item.messageId !== first.messageId).state, "queued");
});

test("inbox keeps unresolved obligations recoverable but does not replay a retrieved note",
  async () => {
    const { service } = makeService();
    const { sender, recipient } = await pair(service);
    const request = await question(service, sender);
    const note = await service.sendMessage({ ...owner(sender), clientMessageId: "client_once",
      toParticipantIds: ["recipient"], kind: "note", obligation: "none",
      subject: "FYI", body: "Show this once." });
    await service.readInbox({ ...owner(recipient) });

    const recovered = await service.readInbox({ ...owner(recipient) });

    assert.deepEqual(recovered.map(item => item.message.messageId), [request.messageId]);
    assert.equal(recovered.some(item => item.message.messageId === note.messageId), false);
    assert.equal(recovered[0].receipt.state, "retrieved");
  });

test("reply preserves the root thread and acknowledges only the replying participant",
  async () => {
    const { service, base } = makeService();
    const sender = await service.openSession(opening("sender"));
    const recipient = await service.openSession(opening("recipient"));
    await service.openSession(opening("other"));
    const original = await question(service, sender, {
      toParticipantIds: ["recipient", "other"] });

    const result = await service.replyToMessage({ ...owner(recipient),
      messageId: original.messageId, clientMessageId: "client_reply",
      body: "Use the offer seam." });

    assert.equal(result.reply.threadId, original.threadId);
    assert.equal(result.reply.inReplyTo, original.messageId);
    assert.equal(result.reply.kind, "answer");
    assert.deepEqual(result.reply.toParticipantIds, ["sender"]);
    assert.equal(result.receipt.state, "acknowledged");
    const originalReceipts = (await base.snapshot(WORKSPACE)).receipts
      .filter(item => item.messageId === original.messageId);
    assert.equal(originalReceipts.find(item => item.recipientParticipantId === "recipient").state,
      "acknowledged");
    assert.equal(originalReceipts.find(item => item.recipientParticipantId === "other").state,
      "queued");
  });

test("replying to a reply retains the original thread root", async () => {
  const { service } = makeService();
  const { sender, recipient } = await pair(service);
  const original = await question(service, sender);
  const firstReply = await service.replyToMessage({ ...owner(recipient),
    messageId: original.messageId, clientMessageId: "client_reply_one", body: "First answer" });

  const secondReply = await service.replyToMessage({ ...owner(sender),
    messageId: firstReply.reply.messageId, clientMessageId: "client_reply_two",
    body: "Thanks" });

  assert.equal(secondReply.reply.threadId, original.messageId);
  assert.equal(secondReply.reply.inReplyTo, firstReply.reply.messageId);
});

test("a participant without the receipt cannot read, reply, or acknowledge", async () => {
  const { service } = makeService();
  const { sender } = await pair(service);
  const stranger = await service.openSession(opening("stranger"));
  const message = await question(service, sender);
  const input = { ...owner(stranger), messageId: message.messageId };

  await assert.rejects(service.readInbox(input), error => error.code === EXIT.CONFLICT);
  await assert.rejects(service.replyToMessage({ ...input, clientMessageId: "client_intercept",
    body: "intercepted" }), error => error.code === EXIT.CONFLICT);
  await assert.rejects(service.acknowledgeMessage(input),
    error => error.code === EXIT.CONFLICT);
});

test("a failure after the reply write rolls back both reply and acknowledgement", async () => {
  let fail = false;
  const { service, base } = makeService({ failAfterReplyWrite: () => fail });
  const { sender, recipient } = await pair(service);
  const original = await question(service, sender);
  fail = true;

  await assert.rejects(service.replyToMessage({ ...owner(recipient),
    messageId: original.messageId, clientMessageId: "client_failed_reply", body: "answer" }),
  /injected failure/);

  const snapshot = await base.snapshot(WORKSPACE);
  assert.deepEqual(snapshot.messages.map(message => message.messageId), [original.messageId]);
  assert.equal(snapshot.receipts.find(item => item.messageId === original.messageId).state,
    "queued");
});
