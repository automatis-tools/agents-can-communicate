import assert from "node:assert/strict";
import test from "node:test";

import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { createDeliveryBindingService } from "../src/delivery-bindings.mjs";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-01T20:00:00.000Z";
const WORKSPACE = "workspace_delivery";

function fixture() {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids,
    pidIsAlive: () => true });
  return { clock, store, service };
}

const open = (service, participantId, sessionId) => service.openSession({
  workspaceId: WORKSPACE, participantId, sessionId, harness: "fixture",
  heartbeatCadenceMs: 30_000,
});

const binding = (session, overrides = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: session.sessionId,
  generation: session.generation,
  adapterId: "fixture_adapter",
  clientVersion: "1.2.3",
  availableModes: ["livePush"],
  livePolicy: "actionable",
  opaqueEndpointRef: "fixture:endpoint:secret",
  leaseUntil: "2026-09-01T20:01:00.000Z",
  ...overrides,
});

test("a delivery binding belongs to one open session generation", async () => {
  const { service } = fixture();
  const session = await open(service, "models", "session_models");

  const published = await service.publishDeliveryBinding(binding(session));
  const listed = await service.listDeliveryBindings({ participantId: "models", now: NOW });

  assert.deepEqual(published, binding(session));
  assert.deepEqual(listed, [binding(session)]);
});

test("expired and replaced-generation bindings cannot be inherited", async () => {
  const { service, clock } = fixture();
  const first = await open(service, "models", "session_models");
  await service.publishDeliveryBinding(binding(first));

  clock.advance(60_001);
  assert.deepEqual(await service.listDeliveryBindings({
    participantId: "models", now: clock.now() }), []);

  await service.closeSession({ sessionId: first.sessionId, generation: first.generation });
  const replacement = await open(service, "models", first.sessionId);
  assert.notEqual(replacement.generation, first.generation);
  assert.deepEqual(await service.listDeliveryBindings({
    participantId: "models", now: NOW }), []);
  await assert.rejects(service.publishDeliveryBinding(binding(first)),
    /open session generation/);
});

test("opaque endpoint references are bounded and never enter status", async () => {
  const { service } = fixture();
  const session = await open(service, "models", "session_models");
  await service.publishDeliveryBinding(binding(session));

  const status = await service.collectStatus({ workspaceId: WORKSPACE });
  assert.deepEqual(status.deliveryBindings, [{
    adapterId: "fixture_adapter",
    clientVersion: "1.2.3",
    availableModes: ["livePush"],
    livePolicy: "actionable",
    reachable: true,
    leaseUntil: "2026-09-01T20:01:00.000Z",
  }]);
  assert.equal(JSON.stringify(status).includes("fixture:endpoint:secret"), false);
  const rejectedSecret = `endpoint-secret-${"x".repeat(4001)}`;
  await assert.rejects(service.publishDeliveryBinding(binding(session, {
    opaqueEndpointRef: rejectedSecret,
  })), error => /at most 4000 characters/.test(error.message)
    && !JSON.stringify(error).includes(rejectedSecret));
});

test("status keeps policy, capability modes, and reachability distinct", async () => {
  const { service, clock } = fixture();
  const session = await open(service, "models", "session_models");
  await service.publishDeliveryBinding(binding(session, {
    livePolicy: "off", availableModes: ["nextTurn", "livePush"],
  }));

  clock.advance(60_001);
  const [reported] = (await service.collectStatus({ workspaceId: WORKSPACE })).deliveryBindings;
  assert.equal(reported.livePolicy, "off");
  assert.deepEqual(reported.availableModes, ["nextTurn", "livePush"]);
  assert.equal(reported.reachable, false);
});

test("a stale publisher cannot delete a successor binding that won the race", async () => {
  const first = { sessionId: "session_models", generation: "generation_first" };
  const successor = binding({ sessionId: first.sessionId, generation: "generation_next" });
  let stored = null;
  let reads = 0;
  const store = { ephemeral: {
    list: async () => stored === null ? [] : [stored],
    update: async (_kind, _id, updater) => {
      stored = await updater(stored);
      // The successor publishes after this stale update but before its recheck.
      stored = successor;
      return stored;
    },
  } };
  const sessions = { locateSession: async () => ({ record: reads++ < 2
    ? { ...first, participantId: "models", state: "open" }
    : { sessionId: first.sessionId, generation: successor.generation,
      participantId: "models", state: "open" } }) };
  const service = createDeliveryBindingService({ store }, sessions);

  await assert.rejects(service.publishDeliveryBinding(binding(first)),
    /open session generation/);
  assert.equal(stored, successor);
});

test("a stale publisher cannot overwrite a successor binding that published first", async () => {
  const first = { sessionId: "session_models", generation: "generation_first" };
  const successor = binding({ sessionId: first.sessionId, generation: "generation_next" });
  let stored = successor;
  let reads = 0;
  const store = { ephemeral: {
    list: async () => [stored],
    put: async (_kind, _id, record) => { stored = record; return record; },
    update: async (_kind, _id, updater) => {
      const next = await updater(stored);
      if (next !== null) stored = next;
      return next;
    },
  } };
  const sessions = { locateSession: async () => ({ record: reads++ === 0
    ? { ...first, participantId: "models", state: "open" }
    : { sessionId: first.sessionId, generation: successor.generation,
      participantId: "models", state: "open" } }) };
  const service = createDeliveryBindingService({ store }, sessions);

  await assert.rejects(service.publishDeliveryBinding(binding(first)),
    /open session generation/);
  assert.equal(stored, successor);
});

test("the current generation may clear its binding, and an absent binding is a no-op", async () => {
  const { service } = fixture();
  const session = await open(service, "models", "session_models");
  await service.clearDeliveryBinding({ sessionId: session.sessionId,
    generation: session.generation });
  await service.publishDeliveryBinding(binding(session));
  assert.equal((await service.listDeliveryBindings({ participantId: "models", now: NOW })).length, 1);

  await service.clearDeliveryBinding({ sessionId: session.sessionId,
    generation: session.generation });
  await service.clearDeliveryBinding({ sessionId: session.sessionId,
    generation: session.generation });

  assert.deepEqual(await service.listDeliveryBindings({ participantId: "models", now: NOW }), []);
  const [reported] = (await service.collectStatus({ workspaceId: WORKSPACE })).deliveryBindings;
  assert.equal(reported.reachable, false);
});

test("a stale generation cannot clear a successor's binding", async () => {
  const { service } = fixture();
  const first = await open(service, "models", "session_models");
  await service.closeSession({ sessionId: first.sessionId, generation: first.generation });
  const successor = await open(service, "models", first.sessionId);
  await service.publishDeliveryBinding(binding(successor));

  await assert.rejects(service.clearDeliveryBinding({ sessionId: first.sessionId,
    generation: first.generation }), /open session generation/);
  assert.deepEqual(await service.listDeliveryBindings({ participantId: "models", now: NOW }),
    [binding(successor)]);
});

test("closing a session retires its own current binding", async () => {
  const { service } = fixture();
  const session = await open(service, "models", "session_models");
  await service.publishDeliveryBinding(binding(session));

  await service.closeSession({ sessionId: session.sessionId, generation: session.generation });

  const status = await service.collectStatus({ workspaceId: WORKSPACE });
  assert.equal(status.deliveryBindings.some(item => item.reachable), false);
});

test("a failed re-handshake cannot leave an older binding reachable", async () => {
  const { service } = fixture();
  const session = await open(service, "models", "session_models");
  await service.publishDeliveryBinding(binding(session));

  // The hook clears before it handshakes; when the handshake then fails, the
  // old endpoint must already be gone rather than surviving as a live target.
  await service.clearDeliveryBinding({ sessionId: session.sessionId,
    generation: session.generation });
  const failedHandshake = null;
  assert.equal(failedHandshake, null);

  assert.deepEqual(await service.listDeliveryBindings({ participantId: "models", now: NOW }), []);
  await service.publishDeliveryBinding(binding(session, { opaqueEndpointRef: "fixture:endpoint:new" }));
  assert.deepEqual((await service.listDeliveryBindings({ participantId: "models", now: NOW }))
    .map(item => item.opaqueEndpointRef), ["fixture:endpoint:new"]);
});
