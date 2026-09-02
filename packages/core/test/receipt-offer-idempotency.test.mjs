import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-01T21:00:00.000Z";
const WORKSPACE = "workspace_receipt_offer";

async function fixture() {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids });
  const sender = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "sender", sessionId: "session_sender", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  const recipient = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "recipient", sessionId: "session_recipient", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  return { clock, recipient, sender, service, store };
}

const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

const send = (f, suffix) => f.service.sendMessage({ ...owner(f.sender),
  clientMessageId: `client_${suffix}`, toParticipantIds: ["recipient"], kind: "question",
  obligation: "reply", subject: `Question ${suffix}`, body: "Please answer." });

const offer = (f, message) => f.service.recordOfferSucceeded({
  messageId: message.messageId, recipientParticipantId: "recipient",
  targetSessionId: f.recipient.sessionId, targetGeneration: f.recipient.generation,
  transport: "next-turn", adapterId: "fixture", clientVersion: "1.0.0",
});

const offerEvents = async f => (await f.store.eventsSince(WORKSPACE, null, 100)).events
  .filter(event => event.type === "message.offer_succeeded");

test("the receipt read seam returns current recipient state without writing", async () => {
  const f = await fixture();
  const message = await send(f, "read");
  const before = await f.store.eventsSince(WORKSPACE, null, 100);

  const receipt = await f.service.readReceipt({ messageId: message.messageId,
    recipientParticipantId: "recipient" });

  assert.equal(receipt.state, "queued");
  assert.equal((await f.store.eventsSince(WORKSPACE, null, 100)).events.length,
    before.events.length);
});

test("offer success is atomic and idempotent after every stronger receipt state", async () => {
  const f = await fixture();
  for (const state of ["offered", "retrieved", "acknowledged"]) {
    const message = await send(f, state);
    if (state === "offered") await offer(f, message);
    if (state === "retrieved") await f.service.readInbox({ ...owner(f.recipient),
      messageId: message.messageId });
    if (state === "acknowledged") await f.service.acknowledgeMessage({
      ...owner(f.recipient), messageId: message.messageId });
    const beforeReceipt = await f.service.readReceipt({ messageId: message.messageId,
      recipientParticipantId: "recipient" });
    const beforeEvents = await offerEvents(f);
    f.clock.advance(1_000);

    const result = await offer(f, message);

    assert.equal(result.state, state);
    assert.deepEqual(result, beforeReceipt);
    assert.equal((await offerEvents(f)).length, beforeEvents.length,
      `${state} appended another offer success`);
  }
});
