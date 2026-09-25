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
