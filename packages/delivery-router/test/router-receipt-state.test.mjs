import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";

import { createDeliveryRouter } from "../src/router.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

// Kept cohesive above 300 lines because every case drives one real receipt,
// binding, and router fixture; splitting would duplicate its race barriers.

const NOW = "2026-09-01T21:00:00.000Z";
const WORKSPACE = "workspace_router_receipts";
const PLATFORM = `${process.platform}-${process.arch}`;

const adapterWith = (offerMessage, { refreshNativeSession, policySource } = {}) => ({
  id: "fixture_adapter",
  client: { command: "fixture-client" },
  capabilities: { delivery: { livePush: true } },
  certification: { evidence: [{ result: "pass", client: "fixture-client",
    version: "1.2.3", platform: PLATFORM, capability: "delivery.livePush" }] },
  nativeDelivery: { minimumByPlatform: { [PLATFORM]: "1.2.3" },
    anchors: [{ platform: PLATFORM, version: "1.2.3", protocolContract: "fixture-native-v1" }],
    knownBad: [], activationKinds: ["shell-bootstrap"], ...(policySource === undefined
      ? {} : { policySource }) },
  refreshNativeSession,
  offerMessage,
});

async function fixture(offerMessage, { refreshNativeSession, readLivePolicy,
  policySource, secondRecipientSession = false, beforeBindingList } = {}) {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const sender = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "sender", sessionId: "session_sender", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  const recipient = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "models", sessionId: "session_models", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  if (secondRecipientSession) await service.openSession({ workspaceId: WORKSPACE,
    participantId: "models", sessionId: "session_models_two", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  const adapter = adapterWith(offerMessage, { refreshNativeSession, policySource });
  let bindingLists = 0;
  const routerService = typeof beforeBindingList !== "function" ? service : { ...service,
    listDeliveryBindings: async input => {
      bindingLists += 1;
      await beforeBindingList(bindingLists);
      return service.listDeliveryBindings(input);
    },
  };
  const router = createDeliveryRouter({ service: routerService,
    adapters: { fixture_adapter: adapter }, clock, platform: PLATFORM, readLivePolicy });
  return { adapter, clock, recipient, router, sender, service, store };
}

const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

const publish = (service, session, overrides = {}) => service.publishDeliveryBinding({
  sessionId: session.sessionId, generation: session.generation,
  adapterId: "fixture_adapter", clientVersion: "1.2.3", availableModes: ["livePush"],
  livePolicy: "actionable", opaqueEndpointRef: `endpoint:${session.sessionId}`,
  leaseUntil: "2026-09-01T21:01:00.000Z",
  ...overrides,
});

const send = (f, suffix, toParticipantIds = ["models"]) => f.service.sendMessage({
  ...owner(f.sender), clientMessageId: `client_${suffix}`, toParticipantIds,
  kind: "question", obligation: "reply", subject: `Question ${suffix}`,
  body: "Please answer.", artifacts: [], inReplyTo: null, handoff: null,
});

const events = async f => (await f.store.eventsSince(WORKSPACE, null, 100)).events
  .filter(event => ["message.offer_succeeded", "message.offer_failed"].includes(event.type));

const refreshedHandshake = (overrides = {}) => ({ supported: true,
  clientVersion: "1.2.3", protocolContract: "fixture-native-v1", modes: ["livePush"],
  opaqueEndpointRef: "endpoint:session_models", leaseUntil: "2026-09-01T21:10:00.000Z",
  reasonCode: null, ...overrides });

test("an expired binding is refreshed once before one offered receipt", async () => {
  let refreshes = 0;
  let offers = 0;
  const f = await fixture(async ({ binding }) => {
    offers += 1;
    return { accepted: true, transport: "codex-app-server",
      clientVersion: binding.clientVersion };
  }, { refreshNativeSession: async () => {
    refreshes += 1;
    return refreshedHandshake();
  } });
  await publish(f.service, f.recipient);
  f.clock.advance(60_001);
  const message = await send(f, "expired_refresh");

  assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
    outcome: "offered", transport: "codex-app-server" }]);
  assert.equal(refreshes, 1);
  assert.equal(offers, 1);
  assert.equal((await f.service.readReceipt({ messageId: message.messageId,
    recipientParticipantId: "models" })).state, "offered");
  const [binding] = await f.service.listDeliveryBindings({
    participantId: "models", now: f.clock.now() });
  assert.equal(binding.leaseUntil, "2026-09-01T21:03:00.001Z");
});

test("an adapter without refresh support leaves an expired receipt queued", async () => {
  let offers = 0;
  const f = await fixture(async () => { offers += 1; });
  await publish(f.service, f.recipient);
  f.clock.advance(60_001);
  const message = await send(f, "expired_no_refresh");

  assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
    outcome: "queued", transport: "durable", errorCode: "recipient_unavailable" }]);
  assert.equal(offers, 0);
  assert.equal((await f.service.readReceipt({ messageId: message.messageId,
    recipientParticipantId: "models" })).state, "queued");
});

for (const [name, duringRefresh] of [
  ["close", async f => f.service.closeSession({ sessionId: f.recipient.sessionId,
    generation: f.recipient.generation })],
  ["retirement", async f => f.service.clearDeliveryBinding({
    sessionId: f.recipient.sessionId, generation: f.recipient.generation })],
  ["endpoint removal", async f => f.store.ephemeral.delete("deliveryBinding",
    f.recipient.sessionId)],
]) {
  test(`${name} during refresh prevents an offer`, async () => {
    let f;
    let offers = 0;
    f = await fixture(async () => { offers += 1; }, {
      refreshNativeSession: async () => {
        await duringRefresh(f);
        return refreshedHandshake();
      },
    });
    await publish(f.service, f.recipient);
    f.clock.advance(60_001);
    const message = await send(f, `refresh_${name.replaceAll(" ", "_")}`);

    assert.equal((await f.router.offer(message))[0].outcome, "queued");
    assert.equal(offers, 0);
  });
}

test("a successor generation published before refresh returns prevents an offer", async () => {
  let f;
  let successor;
  let refreshes = 0;
  let offers = 0;
  f = await fixture(async () => { offers += 1; }, { refreshNativeSession: async () => {
    refreshes += 1;
    await f.service.closeSession({ sessionId: f.recipient.sessionId,
      generation: f.recipient.generation });
    successor = await f.service.openSession({ workspaceId: WORKSPACE, participantId: "models",
      sessionId: f.recipient.sessionId, harness: "fixture", heartbeatCadenceMs: 30_000 });
    await publish(f.service, successor, { opaqueEndpointRef: "endpoint:successor",
      leaseUntil: "2026-09-01T21:04:00.000Z" });
    return refreshedHandshake();
  } });
  await publish(f.service, f.recipient);
  f.clock.advance(60_001);
  const message = await send(f, "refresh_successor");

  const [outcome] = await f.router.offer(message);
  assert.equal(outcome.outcome, "queued");
  assert.equal(offers, 0);
  assert.equal(refreshes, 1, outcome.errorCode);
  const [current] = await f.service.listDeliveryBindings({
    participantId: "models", now: f.clock.now() });
  assert.equal(current.generation, successor.generation);
  assert.equal(current.opaqueEndpointRef, "endpoint:successor");
});

test("policy revoked during refresh prevents an offer", async () => {
  const policies = ["all", "off"];
  let offers = 0;
  const f = await fixture(async () => { offers += 1; }, {
    refreshNativeSession: async () => refreshedHandshake(),
    policySource: "installation-record",
    readLivePolicy: async () => policies.shift(),
  });
  await publish(f.service, f.recipient, { livePolicy: "all" });
  f.clock.advance(60_001);
  const message = await send(f, "refresh_policy_revoked");

  assert.equal((await f.router.offer(message))[0].errorCode, "delivery_disabled");
  assert.equal(offers, 0);
  assert.deepEqual(policies, []);
});

test("a successor published after refresh is rejected by the router re-read", async () => {
  let f;
  let offers = 0;
  f = await fixture(async () => { offers += 1; }, {
    refreshNativeSession: async () => refreshedHandshake(),
    beforeBindingList: async call => {
      if (call !== 2) return;
      await f.service.closeSession({ sessionId: f.recipient.sessionId,
        generation: f.recipient.generation });
      const successor = await f.service.openSession({ workspaceId: WORKSPACE,
        participantId: "models", sessionId: f.recipient.sessionId, harness: "fixture",
        heartbeatCadenceMs: 30_000 });
      await publish(f.service, successor, { opaqueEndpointRef: "endpoint:successor",
        leaseUntil: "2026-09-01T21:04:00.000Z" });
    },
  });
  await publish(f.service, f.recipient);
  f.clock.advance(60_001);

  assert.equal((await f.router.offer(await send(f, "refresh_reread")))[0].outcome, "queued");
  assert.equal(offers, 0);
});

test("two live sessions remain ambiguous before an expired binding is refreshed", async () => {
  let refreshes = 0;
  let offers = 0;
  const f = await fixture(async () => { offers += 1; }, {
    secondRecipientSession: true,
    refreshNativeSession: async () => { refreshes += 1; return refreshedHandshake(); },
  });
  await publish(f.service, f.recipient);
  f.clock.advance(60_001);
  const message = await send(f, "refresh_ambiguous");

  assert.equal((await f.router.offer(message))[0].errorCode, "ambiguous_recipient_sessions");
  assert.equal(refreshes, 0);
  assert.equal(offers, 0);
});

test("sequential offered, retrieved, and acknowledged receipts skip native transport", async () => {
  let calls = 0;
  const f = await fixture(async ({ binding }) => {
    calls += 1;
    return { accepted: true, transport: "codex-app-server",
      clientVersion: binding.clientVersion };
  });
  await publish(f.service, f.recipient);

  const offered = await send(f, "offered");
  assert.equal((await f.router.offer(offered))[0].outcome, "offered");
  assert.deepEqual(await f.router.offer(offered), [{ recipientParticipantId: "models",
    outcome: "offered", transport: "durable" }]);

  const retrieved = await send(f, "retrieved");
  await f.service.readInbox({ ...owner(f.recipient), messageId: retrieved.messageId });
  assert.deepEqual(await f.router.offer(retrieved), [{ recipientParticipantId: "models",
    outcome: "retrieved", transport: "durable" }]);

  const acknowledged = await send(f, "acknowledged");
  await f.service.acknowledgeMessage({ ...owner(f.recipient),
    messageId: acknowledged.messageId });
  assert.deepEqual(await f.router.offer(acknowledged), [{ recipientParticipantId: "models",
    outcome: "acknowledged", transport: "durable" }]);

  assert.equal(calls, 1);
  assert.deepEqual((await events(f)).map(event => event.type), ["message.offer_succeeded"]);
});

for (const state of ["retrieved", "acknowledged"]) {
  test(`accepted transport remains successful when receipt concurrently becomes ${state}`,
    async () => {
      let f;
      const offerMessage = async ({ binding, message }) => {
        if (state === "retrieved") await f.service.readInbox({ ...owner(f.recipient),
          messageId: message.messageId });
        else await f.service.acknowledgeMessage({ ...owner(f.recipient),
          messageId: message.messageId });
        return { accepted: true, transport: "codex-app-server",
          clientVersion: binding.clientVersion };
      };
      f = await fixture(offerMessage);
      await publish(f.service, f.recipient);
      const message = await send(f, `race_${state}`);

      assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
        outcome: "offered", transport: "codex-app-server" }]);
      assert.equal((await f.service.readReceipt({ messageId: message.messageId,
        recipientParticipantId: "models" })).state, state);
      assert.equal((await events(f)).some(event => event.type === "message.offer_failed"), false);
    });
}

test("one settled recipient does not suppress another recipient's queued offer", async () => {
  const calls = [];
  const f = await fixture(async ({ binding }) => {
    calls.push(binding.sessionId);
    return { accepted: true, transport: "codex-app-server",
      clientVersion: binding.clientVersion };
  });
  const other = await f.service.openSession({ workspaceId: WORKSPACE,
    participantId: "other", sessionId: "session_other", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  await publish(f.service, f.recipient);
  await publish(f.service, other);
  const message = await send(f, "isolated", ["models", "other"]);
  await f.service.acknowledgeMessage({ ...owner(f.recipient), messageId: message.messageId });

  assert.deepEqual(await f.router.offer(message), [
    { recipientParticipantId: "models", outcome: "acknowledged", transport: "durable" },
    { recipientParticipantId: "other", outcome: "offered", transport: "codex-app-server" },
  ]);
  assert.deepEqual(calls, [other.sessionId]);
});

test("retrying an obsolete decision cannot live-offer its body; current changes carry lifecycle metadata", async () => {
  const delivered = [];
  const f = await fixture(async ({ binding, message }) => {
    delivered.push(message);
    return { accepted: true, transport: "codex-app-server", clientVersion: binding.clientVersion };
  });
  await publish(f.service, f.recipient);
  const decision = (key, extra = {}) => f.service.sendMessage({ ...owner(f.sender),
    clientMessageId: key, toParticipantIds: ["models"], kind: "decision",
    obligation: "none", subject: key, body: key, ...extra });
  const old = await decision("old");
  const next = await decision("next", { supersedes: [old.messageId] });
  assert.deepEqual(await f.router.offer(old), [{ recipientParticipantId: "models",
    outcome: "queued", transport: "durable" }]);
  assert.equal(delivered.length, 0);
  await f.router.offer(next);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].decisionStatus.state, "current");
  assert.deepEqual(delivered[0].decisionChange, { action: "replace", messageIds: [old.messageId] });
  assert.equal((await f.service.readReceipt({ messageId: old.messageId,
    recipientParticipantId: "models" })).state, "queued");
});

test("a decision replaced during the first offer cannot be offered as current to the next recipient", async () => {
  const delivered = [];
  let f;
  f = await fixture(async ({ binding, message }) => {
    delivered.push(binding.sessionId);
    if (delivered.length === 1) await f.service.sendMessage({ ...owner(f.sender),
      clientMessageId: "replacement", toParticipantIds: [], kind: "decision", obligation: "none",
      subject: "Updated", body: "New choice", supersedes: [message.messageId] });
    return { accepted: true, transport: "codex-app-server", clientVersion: binding.clientVersion };
  });
  const other = await f.service.openSession({ workspaceId: WORKSPACE,
    participantId: "other", harness: "fixture", heartbeatCadenceMs: 30_000 });
  await publish(f.service, f.recipient);
  await publish(f.service, other);
  const old = await f.service.sendMessage({ ...owner(f.sender), clientMessageId: "old",
    toParticipantIds: ["models", "other"], kind: "decision", obligation: "none",
    subject: "Old", body: "Old choice" });
  const outcomes = await f.router.offer(old);
  assert.deepEqual(delivered, [f.recipient.sessionId]);
  assert.deepEqual(outcomes.map(o => o.outcome), ["offered", "queued"]);
  assert.equal((await f.service.readReceipt({ messageId: old.messageId,
    recipientParticipantId: "other" })).state, "queued");
});

test("a second live recipient appearing during refresh keeps the message queued", async () => {
  let f;
  let offers = 0;
  f = await fixture(async ({ binding }) => {
    offers += 1;
    return { accepted: true, transport: "codex-app-server", clientVersion: binding.clientVersion };
  }, { refreshNativeSession: async () => {
    await f.service.openSession({ workspaceId: WORKSPACE, participantId: "models",
      sessionId: "session_new_live", harness: "fixture", heartbeatCadenceMs: 30_000 });
    return refreshedHandshake();
  } });
  await publish(f.service, f.recipient);
  f.clock.advance(60_001);
  const [outcome] = await f.router.offer(await send(f, "became_ambiguous"));
  assert.equal(outcome.errorCode, "ambiguous_recipient_sessions");
  assert.equal(offers, 0);
});
