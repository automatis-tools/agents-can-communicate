import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";

import { createDeliveryRouter } from "../src/router.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-01T20:00:00.000Z";
const WORKSPACE = "workspace_router";
const PLATFORM = `${process.platform}-${process.arch}`;

function certifiedAdapter(offerMessage = async ({ binding }) => ({
  accepted: true, transport: "fixture-live", clientVersion: binding.clientVersion,
})) {
  return {
    id: "fixture_adapter",
    client: { command: "fixture-client" },
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [{ result: "pass", client: "fixture-client",
      version: "1.2.3", platform: PLATFORM, capability: "delivery.livePush" }] },
    offerMessage,
  };
}

async function fixture({ adapter = certifiedAdapter(), secondRecipientSession = false } = {}) {
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
  const sessions = [recipient];
  if (secondRecipientSession) sessions.push(await service.openSession({
    workspaceId: WORKSPACE, participantId: "models", sessionId: "session_models_two",
    harness: "fixture", heartbeatCadenceMs: 30_000 }));
  const router = createDeliveryRouter({ service,
    adapters: { fixture_adapter: adapter }, clock });
  return { adapter, clock, router, sender, service, sessions, store };
}

const publish = (service, session, overrides = {}) => service.publishDeliveryBinding({
  sessionId: session.sessionId, generation: session.generation,
  adapterId: "fixture_adapter", clientVersion: "1.2.3",
  availableModes: ["livePush"], livePolicy: "actionable",
  opaqueEndpointRef: `endpoint:${session.sessionId}`,
  leaseUntil: "2026-09-01T20:01:00.000Z", ...overrides,
});

const content = (kind, overrides = {}) => ({
  kind,
  obligation: ["question", "request"].includes(kind) ? "reply"
    : kind === "handoff" ? "acknowledge" : "none",
  subject: `${kind} subject`, body: `${kind} body`,
  handoff: kind === "handoff" ? { status: "partial", completed: [], remaining: ["work"],
    blockers: [], verification: [] } : null,
  ...overrides,
});

async function send(service, sender, kind = "question", suffix = kind) {
  return service.sendMessage({ sessionId: sender.sessionId, generation: sender.generation,
    clientMessageId: `client_${suffix}`, toParticipantIds: ["models"],
    artifacts: [], inReplyTo: null, ...content(kind) });
}

async function receipt(store, messageId) {
  return (await store.snapshot(WORKSPACE, { kinds: ["receipt"] })).receipts
    .find(item => item.messageId === messageId);
}

const durable = errorCode => [{ recipientParticipantId: "models", outcome: "queued",
  transport: "durable", errorCode }];

test("one eligible certified binding is offered and only then committed", async () => {
  const f = await fixture();
  await publish(f.service, f.sessions[0]);
  const message = await send(f.service, f.sender);

  assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
    outcome: "offered", transport: "fixture-live" }]);
  assert.equal((await receipt(f.store, message.messageId)).state, "offered");
});

test("an adapter throw observes queued and cannot advance the receipt", async () => {
  let stateAtOffer;
  let f;
  const adapter = certifiedAdapter(async () => {
    stateAtOffer = (await receipt(f.store, f.message.messageId)).state;
    throw new Error("endpoint disappeared: secret detail");
  });
  f = await fixture({ adapter });
  await publish(f.service, f.sessions[0]);
  f.message = await send(f.service, f.sender);

  assert.deepEqual(await f.router.offer(f.message), durable("transport_error"));
  assert.equal(stateAtOffer, "queued");
  assert.equal((await receipt(f.store, f.message.messageId)).state, "queued");
  const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
  const failed = events.find(event => event.type === "message.offer_failed");
  assert.equal(failed.payload.safeErrorCode, "transport_error");
  assert.equal(JSON.stringify(failed).includes("secret detail"), false);
});

test("an adapter rejection records safe evidence without advancing the receipt", async () => {
  const adapter = certifiedAdapter(async () => ({ accepted: false,
    transport: "fixture-live", clientVersion: "1.2.3",
    safeErrorCode: "recipient_busy", detail: "secret endpoint detail" }));
  const f = await fixture({ adapter });
  await publish(f.service, f.sessions[0]);
  const message = await send(f.service, f.sender, "request", "rejected");

  assert.deepEqual(await f.router.offer(message), durable("recipient_busy"));
  assert.equal((await receipt(f.store, message.messageId)).state, "queued");
  const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
  const failed = events.find(event => event.type === "message.offer_failed");
  assert.equal(failed.payload.safeErrorCode, "recipient_busy");
  assert.equal(JSON.stringify(failed).includes("secret endpoint detail"), false);
});

test("multiple eligible current sessions are ambiguous and durable-only", async () => {
  const f = await fixture({ secondRecipientSession: true });
  for (const session of f.sessions) await publish(f.service, session);
  const message = await send(f.service, f.sender);

  assert.deepEqual(await f.router.offer(message), durable("ambiguous_recipient_sessions"));
  assert.equal((await receipt(f.store, message.messageId)).state, "queued");
});

test("lease expiry and generation replacement remove a binding from eligibility", async () => {
  const f = await fixture();
  await publish(f.service, f.sessions[0]);
  const expired = await send(f.service, f.sender, "question", "expired");
  f.clock.advance(60_001);
  assert.deepEqual(await f.router.offer(expired), durable("recipient_unavailable"));

  const current = f.sessions[0];
  await f.service.closeSession({ sessionId: current.sessionId, generation: current.generation });
  await f.service.openSession({ workspaceId: WORKSPACE, participantId: "models",
    sessionId: current.sessionId, harness: "fixture", heartbeatCadenceMs: 30_000 });
  const replaced = await send(f.service, f.sender, "question", "replaced");
  assert.deepEqual(await f.router.offer(replaced), durable("recipient_unavailable"));
});

test("off, missing reachability, and uncertified versions stay queued for distinct reasons",
  async () => {
    for (const [name, overrides, errorCode] of [
      ["off", { livePolicy: "off" }, "delivery_disabled"],
      ["no-mode", { availableModes: ["nextTurn"] }, "recipient_unavailable"],
      ["unknown", { clientVersion: "unknown" }, "unsupported_client_version"],
    ]) {
      const f = await fixture();
      await publish(f.service, f.sessions[0], overrides);
      const message = await send(f.service, f.sender, "question", name);
      assert.deepEqual(await f.router.offer(message), durable(errorCode));
      assert.equal((await receipt(f.store, message.messageId)).state, "queued");
    }
  });

test("actionable permits only questions, requests, and addressed handoffs", async () => {
  for (const kind of ["question", "request", "handoff"]) {
    const f = await fixture();
    await publish(f.service, f.sessions[0]);
    const message = await send(f.service, f.sender, kind, `actionable_${kind}`);
    assert.equal((await f.router.offer(message))[0].outcome, "offered", kind);
  }
  for (const kind of ["note", "decision"]) {
    const f = await fixture();
    await publish(f.service, f.sessions[0]);
    const message = await send(f.service, f.sender, kind, `actionable_${kind}`);
    assert.deepEqual(await f.router.offer(message), durable("delivery_disabled"));
  }
});

test("all permits every addressed kind while room messages are never live-pushed", async () => {
  const f = await fixture();
  await publish(f.service, f.sessions[0], { livePolicy: "all" });
  for (const kind of ["note", "decision"]) {
    const message = await send(f.service, f.sender, kind, `all_${kind}`);
    assert.equal((await f.router.offer(message))[0].outcome, "offered", kind);
  }
  const room = await f.service.sendMessage({ sessionId: f.sender.sessionId,
    generation: f.sender.generation, clientMessageId: "client_room",
    toParticipantIds: [], artifacts: [], inReplyTo: null, ...content("note") });
  assert.deepEqual(await f.router.offer(room), []);
});
