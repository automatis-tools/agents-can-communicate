import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { receiptId } from "../src/conversations.mjs";
import { REPEAT_OFFER_AFTER_MS } from "../src/receipts.mjs";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-25T12:00:00.000Z";
const WORKSPACE = "workspace_receipt_visibility";

async function fixture() {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids });
  const open = participantId => service.openSession({ workspaceId: WORKSPACE, participantId,
    sessionId: `session_${participantId}`, harness: "fixture", heartbeatCadenceMs: 30_000 });
  return { clock, store, service, sender: await open("sender"),
    recipient: await open("recipient"), other: await open("other") };
}

const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

let sent = 0;
const send = (f, overrides = {}) => f.service.sendMessage({ ...owner(f.sender),
  clientMessageId: `client_${sent += 1}`, toParticipantIds: ["recipient"], kind: "note",
  obligation: "none", subject: "The schema is verified", body: "Checked at abc123.",
  ...overrides });

const offer = (f, message, { transport = "codex-app-server", repeat, to = f.recipient } = {}) =>
  f.service.recordOfferSucceeded({ messageId: message.messageId,
    recipientParticipantId: to.participantId, targetSessionId: to.sessionId,
    targetGeneration: to.generation, transport, adapterId: "fixture", clientVersion: "1.0.0",
    ...(repeat === undefined ? {} : { repeat }) });

const receipt = (f, message, participantId = "recipient") => f.service.readReceipt({
  messageId: message.messageId, recipientParticipantId: participantId });

const offerEvents = async f => (await f.store.eventsSince(WORKSPACE, null, 1_000)).events
  .filter(event => event.type === "message.offer_succeeded");

// What ACC 0.7.0 leaves behind: an offered receipt with no offer facts at all.
async function rewriteReceipt(f, message, change) {
  const id = receiptId(message.messageId, "recipient");
  await f.store.transaction(tx => {
    const current = tx.get("receipt", id);
    tx.put("receipt", id, change(current), tx.generationOf("receipt", id));
  }, { kinds: ["receipt"] });
}

test("a first offer records how and when the transport accepted it", async () => {
  const f = await fixture();
  const message = await send(f);

  await offer(f, message);

  assert.deepEqual((await receipt(f, message)).extensions,
    { offer: { transport: "codex-app-server", at: NOW, repeatedAt: null } });
});

test("a first offer keeps extension keys it does not own", async () => {
  const f = await fixture();
  const message = await send(f);
  await rewriteReceipt(f, message, current => ({ ...current,
    extensions: { later: { kept: true } } }));

  await offer(f, message);

  assert.deepEqual((await receipt(f, message)).extensions.later, { kept: true });
  assert.equal((await receipt(f, message)).extensions.offer.transport, "codex-app-server");
});

test("a live offer nobody followed up is repeated once, as another offer event", async () => {
  const f = await fixture();
  const message = await send(f);
  await offer(f, message);
  const repeatedAt = f.clock.advance(REPEAT_OFFER_AFTER_MS);

  const result = await offer(f, message, { transport: "next-turn", repeat: true });

  // The receipt keeps its state and its state-change time: a repeat is an
  // attempt, never a transition and never a second message.
  assert.equal(result.state, "offered");
  assert.equal(result.updatedAt, NOW);
  assert.deepEqual(result.extensions.offer,
    { transport: "codex-app-server", at: NOW, repeatedAt });
  assert.deepEqual(await receipt(f, message), result);
  const [first, repeat] = await offerEvents(f);
  assert.equal(first.payload.transport, "codex-app-server");
  assert.equal(Object.hasOwn(first.payload, "repeat"), false);
  assert.equal(repeat.payload.transport, "next-turn");
  assert.equal(repeat.payload.repeat, true);
  assert.equal(repeat.payload.messageId, message.messageId);
  assert.equal(repeat.occurredAt, repeatedAt);
});

test("a repeat that is not due changes nothing and records nothing", async () => {
  const cases = {
    "before the threshold": async (f, message) => {
      await offer(f, message);
      f.clock.advance(REPEAT_OFFER_AFTER_MS - 1);
    },
    "after a next-turn offer": async (f, message) => {
      await offer(f, message, { transport: "next-turn" });
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
    },
    "on a receipt an older ACC offered": async (f, message) => {
      await offer(f, message);
      await rewriteReceipt(f, message, ({ extensions, ...current }) => current);
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
    },
    "on a queued receipt": async f => {
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
    },
    "after retrieval": async (f, message) => {
      await offer(f, message);
      await f.service.readInbox({ ...owner(f.recipient), messageId: message.messageId });
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
    },
    "after acknowledgement": async (f, message) => {
      await offer(f, message);
      await f.service.acknowledgeMessage({ ...owner(f.recipient),
        messageId: message.messageId });
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
    },
    "a second time": async (f, message) => {
      await offer(f, message);
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
      await offer(f, message, { transport: "next-turn", repeat: true });
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const f = await fixture();
    const message = await send(f);
    await arrange(f, message);
    const before = await receipt(f, message);
    const events = (await offerEvents(f)).length;

    const result = await offer(f, message, { transport: "next-turn", repeat: true });

    assert.deepEqual(result, before, name);
    assert.deepEqual(await receipt(f, message), before, name);
    assert.equal((await offerEvents(f)).length, events, `${name} appended an offer event`);
  }
});

test("a repeat travels only through the next turn", async () => {
  const f = await fixture();
  const message = await send(f);
  await offer(f, message);
  f.clock.advance(REPEAT_OFFER_AFTER_MS);

  await assert.rejects(offer(f, message, { transport: "claude-channel", repeat: true }),
    error => error.code === EXIT.DATA && /next turn/.test(error.message));
  assert.equal((await receipt(f, message)).extensions.offer.repeatedAt, null);
});

test("an exact history read shows every recipient's receipt to its reader", async () => {
  const f = await fixture();
  const message = await send(f, { toParticipantIds: ["recipient", "other"] });
  await offer(f, message);
  const later = f.clock.advance(60_000);
  await f.service.readInbox({ ...owner(f.other), messageId: message.messageId });

  const read = await f.service.sync({ scope: "history", messageId: message.messageId });

  assert.deepEqual(read.receipts, [
    { recipientParticipantId: "other", state: "retrieved", updatedAt: later, offer: null },
    { recipientParticipantId: "recipient", state: "offered", updatedAt: NOW,
      offer: { transport: "codex-app-server", at: NOW, repeatedAt: null } },
  ]);
  // The router reads a decision back through this same call and offers
  // `items[0]`: the record it hands a transport must stay the message itself.
  assert.equal(read.items.length, 1);
  assert.equal(Object.hasOwn(read.items[0], "receipts"), false);
  assert.equal(read.items[0].body, "Checked at abc123.");
});

test("a receipt an older ACC offered reads as offered by an unknown transport", async () => {
  const f = await fixture();
  const message = await send(f);
  await offer(f, message);
  await rewriteReceipt(f, message, ({ extensions, ...current }) => current);

  const read = await f.service.sync({ scope: "history", messageId: message.messageId });

  assert.deepEqual(read.receipts, [{ recipientParticipantId: "recipient",
    state: "offered", updatedAt: NOW, offer: null }]);
});

test("a history page of summaries carries no receipts", async () => {
  const f = await fixture();
  await send(f);

  const page = await f.service.sync({ scope: "history" });

  assert.equal(Object.hasOwn(page, "receipts"), false);
});

test("status counts what each participant has not retrieved, split by how far it got", async () => {
  const f = await fixture();
  const offered = await send(f);
  await offer(f, offered);
  await send(f);
  const retrieved = await send(f);
  await f.service.readInbox({ ...owner(f.recipient), messageId: retrieved.messageId });
  await send(f, { toParticipantIds: ["other"] });

  const status = await f.service.collectStatus({ workspaceId: WORKSPACE });

  const row = participantId => status.participants
    .find(item => item.participantId === participantId).unretrieved;
  assert.deepEqual(row("recipient"), { queued: 1, offered: 1 });
  assert.deepEqual(row("other"), { queued: 1, offered: 0 });
  assert.deepEqual(row("sender"), { queued: 0, offered: 0 });
  assert.deepEqual(status.counts.unretrieved, { queued: 2, offered: 1 });
});

test("a replaced decision leaves the unretrieved counts, as it leaves the inbox", async () => {
  const f = await fixture();
  const old = await send(f, { kind: "decision", obligation: "acknowledge" });
  await send(f, { kind: "decision", obligation: "acknowledge", supersedes: [old.messageId] });

  const status = await f.service.collectStatus({ workspaceId: WORKSPACE });

  assert.deepEqual(status.participants
    .find(item => item.participantId === "recipient").unretrieved, { queued: 1, offered: 0 });
});

const deliver = (f, extra = {}) => f.service.nextTurnDelivery({ workspaceId: WORKSPACE,
  participantId: "recipient", exceptSessionId: f.recipient.sessionId, ...extra });

test("a live offer nobody followed up is selected for one repeat after new messages", async () => {
  const f = await fixture();
  const question = await send(f, { kind: "question", obligation: "reply" });
  await offer(f, question);
  f.clock.advance(REPEAT_OFFER_AFTER_MS);
  const fresh = await send(f);

  const delivery = await deliver(f, { repeats: true });

  assert.deepEqual(delivery.queuedMessages.map(item => item.messageId), [fresh.messageId]);
  assert.deepEqual(delivery.repeatMessages.map(item => item.messageId), [question.messageId]);
  assert.deepEqual(delivery.repeatOffers, [{ messageId: question.messageId,
    transport: "codex-app-server", at: NOW }]);
  // Shown whole this turn, so it is neither a breadcrumb nor a reminder count.
  assert.equal(delivery.liveOfferedMessageIds.includes(question.messageId), false);
  assert.equal(delivery.reminderMessageIds.includes(question.messageId), false);
});

test("only a caller that asks for repeats gets them, and the others see what they saw", async () => {
  const f = await fixture();
  const question = await send(f, { kind: "question", obligation: "reply" });
  await offer(f, question);
  f.clock.advance(REPEAT_OFFER_AFTER_MS);

  const delivery = await deliver(f);

  assert.deepEqual(delivery.repeatMessages, []);
  assert.deepEqual(delivery.repeatOffers, []);
  assert.deepEqual(delivery.liveOfferedMessageIds, [question.messageId]);
  assert.deepEqual(delivery.reminderMessageIds, [question.messageId]);
});

test("nothing is selected for a repeat before it is due", async () => {
  const cases = {
    "before the threshold": async (f, message) => {
      await offer(f, message);
      f.clock.advance(REPEAT_OFFER_AFTER_MS - 1);
    },
    "after a next-turn offer": async (f, message) => {
      await offer(f, message, { transport: "next-turn" });
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
    },
    "once it was repeated": async (f, message) => {
      await offer(f, message);
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
      await offer(f, message, { transport: "next-turn", repeat: true });
      f.clock.advance(REPEAT_OFFER_AFTER_MS);
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const f = await fixture();
    await arrange(f, await send(f));

    assert.deepEqual((await deliver(f, { repeats: true })).repeatMessages, [], name);
  }
});

test("a repeat keeps offer facts it does not own", async () => {
  const f = await fixture();
  const message = await send(f);
  await offer(f, message);
  // A later ACC may record more about an offer. This one must not drop it.
  await rewriteReceipt(f, message, current => ({ ...current, extensions: { ...current.extensions,
    offer: { ...current.extensions.offer, targetSessionId: "session_future" } } }));
  f.clock.advance(REPEAT_OFFER_AFTER_MS);

  await offer(f, message, { transport: "next-turn", repeat: true });

  const { offer: facts } = (await receipt(f, message)).extensions;
  assert.equal(facts.targetSessionId, "session_future");
  assert.equal(typeof facts.repeatedAt, "string");
});
