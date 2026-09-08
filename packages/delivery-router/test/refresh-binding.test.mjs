import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";

import { refreshExpiredBinding } from "../src/refresh-binding.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-01T20:02:00.001Z";
const WORKSPACE = "workspace_refresh_binding";
const PLATFORM = `${process.platform}-${process.arch}`;

function adapterWith(refreshNativeSession) {
  return {
    id: "fixture_adapter",
    nativeDelivery: {
      minimumByPlatform: { [PLATFORM]: "1.2.3" },
      anchors: [{ platform: PLATFORM, version: "1.2.3",
        protocolContract: "fixture-native-v1" }],
      knownBad: [], activationKinds: ["shell-bootstrap"],
    },
    refreshNativeSession,
  };
}

function handshake(overrides = {}) {
  return {
    supported: true,
    clientVersion: "1.2.3",
    protocolContract: "fixture-native-v1",
    modes: ["livePush"],
    opaqueEndpointRef: "endpoint:models",
    leaseUntil: "2026-09-01T20:07:00.001Z",
    reasonCode: null,
    ...overrides,
  };
}

async function fixture() {
  const clock = createFakeClock("2026-09-01T20:00:00.000Z");
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const sender = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "sender", sessionId: "session_sender", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  void sender;
  const session = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "models", sessionId: "session_models", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  const binding = {
    sessionId: session.sessionId, generation: session.generation,
    adapterId: "fixture_adapter", clientVersion: "1.2.3", availableModes: ["livePush"],
    livePolicy: "actionable", opaqueEndpointRef: "endpoint:models",
    leaseUntil: "2026-09-01T20:01:00.000Z",
  };
  await service.publishDeliveryBinding(binding);
  clock.advance(120_001);
  return { binding: (await service.listDeliveryBindings({ participantId: "models",
    now: clock.now(), includeExpired: true }))[0], clock, service, session, store };
}

test("a valid refresh extends the existing binding and caps its lease at 120 seconds", async () => {
  const f = await fixture();
  let nativeCalls = 0;
  let refreshCalls = 0;
  let publishCalls = 0;
  const adapter = adapterWith(async ({ binding, runtimeDir, timeoutMs }) => {
    nativeCalls += 1;
    assert.equal(binding.opaqueEndpointRef, "endpoint:models");
    assert.equal(runtimeDir, f.store.root);
    assert.equal(timeoutMs, 321);
    return handshake();
  });
  const service = { ...f.service,
    refreshDeliveryBinding: async input => {
      refreshCalls += 1;
      return f.service.refreshDeliveryBinding(input);
    },
    publishDeliveryBinding: async input => {
      publishCalls += 1;
      return f.service.publishDeliveryBinding(input);
    },
  };

  assert.equal(await refreshExpiredBinding({ service, adapter, binding: f.binding,
    runtimeDir: f.store.root, platform: PLATFORM, clock: f.clock, timeoutMs: 321 }), true);
  assert.equal(nativeCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(publishCalls, 0);
  const [renewed] = await f.service.listDeliveryBindings({
    participantId: "models", now: f.clock.now() });
  assert.equal(renewed.leaseUntil, "2026-09-01T20:04:00.001Z");
  assert.equal(renewed.opaqueEndpointRef, f.binding.opaqueEndpointRef);
});

test("refresh refuses invalid identity, platform, and lease handshakes", async () => {
  for (const [name, platform, result] of [
    ["endpoint", PLATFORM, handshake({ opaqueEndpointRef: "endpoint:other" })],
    ["version", PLATFORM, handshake({ clientVersion: "1.2.4" })],
    ["platform", "uncaptured-platform", handshake()],
    ["past lease", PLATFORM, handshake({ leaseUntil: NOW })],
  ]) {
    const f = await fixture();
    let refreshCalls = 0;
    const service = { ...f.service, refreshDeliveryBinding: async input => {
      refreshCalls += 1;
      return f.service.refreshDeliveryBinding(input);
    } };
    const adapter = adapterWith(async () => result);

    assert.equal(await refreshExpiredBinding({ service, adapter, binding: f.binding,
      runtimeDir: f.store.root, platform, clock: f.clock }), false, name);
    assert.equal(refreshCalls, 0, name);
  }
});

test("missing refresh support leaves the expired binding untouched", async () => {
  const f = await fixture();
  assert.equal(await refreshExpiredBinding({ service: f.service, adapter: adapterWith(undefined),
    binding: f.binding, runtimeDir: f.store.root, platform: PLATFORM, clock: f.clock }), false);
  assert.deepEqual(await f.service.listDeliveryBindings({ participantId: "models",
    now: f.clock.now() }), []);
});

test("post-refresh state must still name the same current endpoint", async () => {
  const f = await fixture();
  const service = { ...f.service, refreshDeliveryBinding: async input => {
    await f.service.refreshDeliveryBinding(input);
    await f.service.publishDeliveryBinding({ ...f.binding,
      opaqueEndpointRef: "endpoint:replacement", leaseUntil: "2026-09-01T20:04:00.001Z" });
  } };

  assert.equal(await refreshExpiredBinding({ service,
    adapter: adapterWith(async () => handshake()), binding: f.binding,
    runtimeDir: f.store.root, platform: PLATFORM, clock: f.clock }), false);
  const [replacement] = await f.service.listDeliveryBindings({
    participantId: "models", now: f.clock.now() });
  assert.equal(replacement.opaqueEndpointRef, "endpoint:replacement");
});

test("retirement during the RPC cannot be revived", async () => {
  const f = await fixture();
  const adapter = adapterWith(async () => {
    await f.service.clearDeliveryBinding({ sessionId: f.session.sessionId,
      generation: f.session.generation });
    return handshake();
  });

  assert.equal(await refreshExpiredBinding({ service: f.service, adapter, binding: f.binding,
    runtimeDir: f.store.root, platform: PLATFORM, clock: f.clock }), false);
  assert.deepEqual(await f.service.listDeliveryBindings({ participantId: "models",
    now: f.clock.now(), includeExpired: true }), []);
});
