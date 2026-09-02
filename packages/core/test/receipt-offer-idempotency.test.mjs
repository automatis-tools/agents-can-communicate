import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

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

test("settled receipts still reject every invalid generation-bound target without writes",
  async () => {
    for (const state of ["offered", "retrieved", "acknowledged"]) {
      for (const invalidTarget of ["wrong participant", "closed target", "wrong generation"]) {
        const f = await fixture();
        const message = await send(f, `${state}_${invalidTarget.replaceAll(" ", "_")}`);
        if (state === "offered") await offer(f, message);
        if (state === "retrieved") await f.service.readInbox({ ...owner(f.recipient),
          messageId: message.messageId });
        if (state === "acknowledged") await f.service.acknowledgeMessage({
          ...owner(f.recipient), messageId: message.messageId });

        let targetSessionId = f.recipient.sessionId;
        let targetGeneration = f.recipient.generation;
        if (invalidTarget === "wrong participant") {
          targetSessionId = f.sender.sessionId;
          targetGeneration = f.sender.generation;
        }
        if (invalidTarget === "closed target") {
          await f.service.closeSession(owner(f.recipient));
        }
        if (invalidTarget === "wrong generation") targetGeneration = "generation_stale";

        const beforeReceipt = await f.service.readReceipt({ messageId: message.messageId,
          recipientParticipantId: "recipient" });
        const beforeEvents = await f.store.eventsSince(WORKSPACE, null, 100);
        await assert.rejects(f.service.recordOfferSucceeded({ messageId: message.messageId,
          recipientParticipantId: "recipient", targetSessionId, targetGeneration,
          transport: "next-turn", adapterId: "fixture", clientVersion: "1.0.0",
        }), error => error.code === EXIT.CONFLICT && /offer target/.test(error.message),
        `${state}: ${invalidTarget}`);

        assert.deepEqual(await f.service.readReceipt({ messageId: message.messageId,
          recipientParticipantId: "recipient" }), beforeReceipt,
        `${state}: ${invalidTarget} changed the receipt`);
        assert.deepEqual(await f.store.eventsSince(WORKSPACE, null, 100), beforeEvents,
        `${state}: ${invalidTarget} appended an event`);
      }
    }
  });
