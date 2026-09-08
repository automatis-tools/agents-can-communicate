import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";
import { createDeliveryRouter } from "../src/router.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const WORKSPACE = "workspace_current_binding";
const PLATFORM = `${process.platform}-${process.arch}`;

function barrier() {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  return { entered: entered.promise, resume: resumed.resolve,
    async pause() { entered.resolve(); await resumed.promise; } };
}

async function fixture({ refreshed, boundary, kind = "question" }) {
  const clock = createFakeClock("2026-09-01T20:00:00.000Z");
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const open = participantId => service.openSession({ workspaceId: WORKSPACE,
    participantId, harness: "fixture", heartbeatCadenceMs: 30_000 });
  const sender = await open("sender");
  const recipient = await open("receiver");
  const original = { sessionId: recipient.sessionId, generation: recipient.generation,
    adapterId: "fixture", clientVersion: "1.2.3", availableModes: ["livePush"],
    livePolicy: "actionable", opaqueEndpointRef: "endpoint_original",
    leaseUntil: "2026-09-01T20:01:00.000Z" };
  await service.publishDeliveryBinding(original);
  if (refreshed) clock.advance(120_001);
  const future = () => new Date(Date.parse(clock.now()) + 120_000).toISOString();
  const gate = barrier();
  let policyReads = 0;
  let sessionReads = 0;
  let refreshes = 0;
  let historyReads = 0;
  const offers = [];
  const adapter = { id: "fixture", capabilities: { delivery: { livePush: true } },
    nativeDelivery: { policySource: "installation-record",
      minimumByPlatform: { [PLATFORM]: "1.2.3" },
      anchors: [{ platform: PLATFORM, version: "1.2.3", protocolContract: "fixture-native-v1" }],
      knownBad: [], activationKinds: ["native-service"] },
    refreshNativeSession: async () => {
      refreshes += 1;
      return { supported: true, clientVersion: "1.2.3", protocolContract: "fixture-native-v1",
        modes: ["livePush"], opaqueEndpointRef: original.opaqueEndpointRef,
        leaseUntil: future(), reasonCode: null };
    },
    offerMessage: async ({ binding }) => {
      offers.push(binding);
      return { accepted: true, clientVersion: "1.2.3" };
    } };
  const router = createDeliveryRouter({
    service: { ...service, sync: async input => {
      const result = await service.sync(input);
      if (++historyReads === 2 && boundary === "history") await gate.pause();
      return result;
    }, listLiveSessions: async input => {
      const sessions = await service.listLiveSessions(input);
      if (++sessionReads === 2 && boundary === "session") await gate.pause();
      return sessions;
    } },
    adapters: [adapter], clock, platform: PLATFORM,
    readLivePolicy: async () => {
      if (++policyReads === 2 && boundary === "policy") await gate.pause();
      return "actionable";
    },
  });
  const message = await service.sendMessage({ sessionId: sender.sessionId,
    generation: sender.generation, clientMessageId: "client_current_binding", kind,
    obligation: kind === "decision" ? "none" : "reply", toParticipantIds: ["receiver"], subject: "Binding race", body: "Fixture",
    artifacts: [], inReplyTo: null, handoff: null });
  return { clock, service, store, recipient, original, future, gate, offers,
    refreshes: () => refreshes, router, message };
}

const changes = [
  ["retirement", f => f.service.clearDeliveryBinding(f.recipient)],
  ["same-generation endpoint replacement", f => f.service.publishDeliveryBinding({
    ...f.original, opaqueEndpointRef: "endpoint_successor", leaseUntil: f.future() })],
  ["same-generation adapter replacement", f => f.service.publishDeliveryBinding({
    ...f.original, adapterId: "other_adapter", leaseUntil: f.future() })],
  ["same-generation version replacement", f => f.service.publishDeliveryBinding({
    ...f.original, clientVersion: "1.2.4", leaseUntil: f.future() })],
  ["live mode removal", f => f.service.publishDeliveryBinding({
    ...f.original, availableModes: [], leaseUntil: f.future() })],
  ["lease expiry", async f => {
    const current = await f.store.ephemeral.get("deliveryBinding", f.recipient.sessionId);
    f.clock.advance(Date.parse(current.leaseUntil) - Date.parse(f.clock.now()));
  }],
  ["generation replacement", async f => {
    await f.service.closeSession(f.recipient);
    const successor = await f.service.openSession({ workspaceId: WORKSPACE,
      participantId: "receiver", sessionId: f.recipient.sessionId,
      harness: "fixture", heartbeatCadenceMs: 30_000 });
    await f.service.publishDeliveryBinding({ ...f.original,
      generation: successor.generation, leaseUntil: f.future() });
  }],
];

// Removing the final authoritative query must fail these transport and durable
// receipt assertions. Barriers wrap actual core reads; only transport is a fake.
for (const refreshed of [false, true]) {
  for (const boundary of ["policy", "session"]) {
    for (const [name, change] of changes) {
      test(`${refreshed ? "refreshed" : "fresh"}: ${name} during final ${boundary} await stays queued`,
        async () => {
          const f = await fixture({ refreshed, boundary });
          const pending = f.router.offer(f.message);
          await f.gate.entered;
          try { await change(f); } finally { f.gate.resume(); }
          const outcomes = await pending;
          const receipt = await f.service.readReceipt({ messageId: f.message.messageId,
            recipientParticipantId: "receiver" });
          const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
          assert.deepEqual({ offers: f.offers.length, outcomes, receiptState: receipt.state,
            offeredEvents: events.filter(event => event.type === "message.offer_succeeded").length },
          { offers: 0, outcomes: [{ recipientParticipantId: "receiver", outcome: "queued",
            transport: "durable", errorCode: "recipient_unavailable" }],
          receiptState: "queued", offeredEvents: 0 });
          assert.equal(f.refreshes(), refreshed ? 1 : 0);
        });
    }
  }

  test(`${refreshed ? "refreshed" : "fresh"}: unchanged binding still offers after final await`,
    async () => {
      const f = await fixture({ refreshed, boundary: "session" });
      const pending = f.router.offer(f.message);
      await f.gate.entered;
      f.gate.resume();
      assert.equal((await pending)[0].outcome, "offered");
      assert.equal(f.offers.length, 1);
      assert.equal(f.offers[0].opaqueEndpointRef, "endpoint_original");
      assert.equal(f.refreshes(), refreshed ? 1 : 0);
      assert.equal((await f.service.readReceipt({ messageId: f.message.messageId,
        recipientParticipantId: "receiver" })).state, "offered");
    });
}

// The merged decision read is another await before the final binding lookup.
// Moving that lookup above this read must let the retired endpoint reach transport.
test("a decision history read racing with retirement cannot offer the obsolete binding", async () => {
  const f = await fixture({ refreshed: false, boundary: "history", kind: "decision" });
  const pending = f.router.offer(f.message);
  await f.gate.entered;
  try { await f.service.clearDeliveryBinding(f.recipient); } finally { f.gate.resume(); }
  const outcomes = await pending;
  assert.equal(f.offers.length, 0);
  assert.deepEqual(outcomes, [{ recipientParticipantId: "receiver", outcome: "queued",
    transport: "durable", errorCode: "recipient_unavailable" }]);
  assert.equal((await f.service.readReceipt({ messageId: f.message.messageId,
    recipientParticipantId: "receiver" })).state, "queued");
});
