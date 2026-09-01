import assert from "node:assert/strict";
import test from "node:test";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-01T19:00:00.000Z";
const WORKSPACE = "workspace_finish_retries";

function makeService() {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  return { store, clock, ids,
    service: createCoordinationService({ store, clock, ids }) };
}

const opening = participantId => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000 });
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
const handoff = Object.freeze({ status: "partial", completed: [], remaining: [],
  blockers: [], verification: [] });

async function pair(service) {
  const sender = await service.openSession(opening("sender"));
  await service.openSession(opening("recipient"));
  return sender;
}

const finishInput = sender => ({ ...owner(sender), clientMessageId: "client_finish_retry",
  toParticipantId: "recipient", goal: "finish the handoff", status: "partial",
  completed: [], remaining: [], blockers: [], verification: [], artifacts: [] });

async function sendMatchingHandoff(service, sender) {
  return service.sendMessage({ ...owner(sender), clientMessageId: "client_finish_retry",
    toParticipantIds: ["recipient"], kind: "handoff", obligation: "acknowledge",
    subject: "finish the handoff", body: "finish the handoff\npartial", inReplyTo: null,
    artifacts: [], handoff });
}

async function closeWithTestMarker({ store, clock, ids }, session, payload) {
  const now = clock.now();
  await store.transaction(tx => {
    const current = tx.get("session", session.sessionId);
    tx.put("session", session.sessionId, { ...current, state: "closed", heartbeatAt: now },
      tx.generationOf("session", session.sessionId));
    tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
      workspaceId: session.workspaceId, actorSessionId: session.sessionId,
      type: "session.closed", occurredAt: now, payload });
  }, { kinds: ["session"] });
}

async function expectRetryConflict(environment, sender) {
  const { store, clock, ids } = environment;
  const before = await store.eventsSince(WORKSPACE, null, 100);
  const restarted = createCoordinationService({ store, clock, ids });
  await assert.rejects(restarted.finishSession(finishInput(sender)),
    error => error.code === EXIT.CONFLICT);
  const after = await store.eventsSince(WORKSPACE, null, 100);
  assert.equal(after.events.length, before.events.length);
}

test("ordinary handoff, release, and close cannot masquerade as finish response loss",
  async () => {
    const environment = makeService();
    const { service, store } = environment;
    const sender = await pair(service);
    const released = await service.acquireClaim({ ...owner(sender),
      resource: "file:released.mjs", reason: "released separately" });
    const stillOwned = await service.acquireClaim({ ...owner(sender),
      resource: "file:still-owned.mjs", reason: "must not be hidden" });
    await sendMatchingHandoff(service, sender);
    await service.releaseClaim({ ...owner(sender), claimId: released.claimId });
    await service.closeSession(owner(sender));

    await expectRetryConflict(environment, sender);
    const claims = (await store.snapshot(WORKSPACE)).claims;
    assert.deepEqual(claims.map(claim => claim.claimId), [stillOwned.claimId]);
  });

test("finish retry rejects a close marker with a mismatched release set", async () => {
  const environment = makeService();
  const { service } = environment;
  const sender = await pair(service);
  const claim = await service.acquireClaim({ ...owner(sender), resource: "file:released.mjs",
    reason: "released separately" });
  const message = await sendMatchingHandoff(service, sender);
  await service.releaseClaim({ ...owner(sender), claimId: claim.claimId });
  await closeWithTestMarker(environment, sender, { cause: "finish",
    messageId: message.messageId, sessionGeneration: sender.generation,
    releasedClaimIds: [] });

  await expectRetryConflict(environment, sender);
});

test("finish retry rejects a malformed close marker", async () => {
  const environment = makeService();
  const { service } = environment;
  const sender = await pair(service);
  const claim = await service.acquireClaim({ ...owner(sender), resource: "file:released.mjs",
    reason: "released separately" });
  const message = await sendMatchingHandoff(service, sender);
  await service.releaseClaim({ ...owner(sender), claimId: claim.claimId });
  await closeWithTestMarker(environment, sender, { cause: "finish",
    messageId: message.messageId, sessionGeneration: sender.generation,
    releasedClaimIds: claim.claimId });

  await expectRetryConflict(environment, sender);
});

test("finish retry requires its recorded, released, and closed events to be contiguous",
  async () => {
    const environment = makeService();
    const { service } = environment;
    const sender = await pair(service);
    const claim = await service.acquireClaim({ ...owner(sender), resource: "file:released.mjs",
      reason: "released separately" });
    const message = await sendMatchingHandoff(service, sender);
    await service.releaseClaim({ ...owner(sender), claimId: claim.claimId });
    await service.setIntent({ ...owner(sender), summary: "an intervening transaction",
      mode: "edit" });
    await closeWithTestMarker(environment, sender, { cause: "finish",
      messageId: message.messageId, sessionGeneration: sender.generation,
      releasedClaimIds: [claim.claimId] });

    await expectRetryConflict(environment, sender);
  });

test("finish writes one minimal system correlation and ordinary close cannot forge it",
  async () => {
    const { service, store } = makeService();
    const sender = await pair(service);
    const claim = await service.acquireClaim({ ...owner(sender), resource: "file:released.mjs",
      reason: "private reason" });

    const result = await service.finishSession(finishInput(sender));
    const events = (await store.eventsSince(WORKSPACE, null, 100)).events;
    const recordedIndex = events.findIndex(event => event.type === "message.recorded"
      && event.payload.messageId === result.message.messageId);
    const correlated = events.find(event => event.type === "session.closed"
      && event.actorSessionId === sender.sessionId);

    assert.deepEqual(events.slice(recordedIndex).map(event => event.type),
      ["message.recorded", "claim.released", "session.closed"]);
    assert.deepEqual(correlated.payload, { cause: "finish",
      messageId: result.message.messageId, sessionGeneration: sender.generation,
      releasedClaimIds: [claim.claimId] });
    assert.equal(JSON.stringify(correlated.payload).includes("private reason"), false);

    const ordinary = await service.openSession(opening("ordinary"));
    await service.closeSession({ ...owner(ordinary), cause: "finish",
      messageId: result.message.messageId, releasedClaimIds: [claim.claimId] });
    const after = (await store.eventsSince(WORKSPACE, null, 100)).events;
    const ordinaryClose = after.find(event => event.type === "session.closed"
      && event.actorSessionId === ordinary.sessionId);
    assert.deepEqual(ordinaryClose.payload, {});
  });
