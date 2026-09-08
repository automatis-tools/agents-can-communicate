import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

import { createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { establishNativeBinding } from "../src/native-binding.mjs";

const clock = { now: () => new Date().toISOString() };

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-native-retirement-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = createFakeIds();
  const store = await openFilesystemStore({ root, clock, ids, workspaceId: "workspace_a" });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const session = await service.openSession({ workspaceId: "workspace_a", participantId: "receiver",
    sessionId: "session_receiver", harness: "fixture", heartbeatCadenceMs: 60_000 });
  await service.publishDeliveryBinding({ sessionId: session.sessionId, generation: session.generation,
    adapterId: "fixture", clientVersion: "1.2.3", availableModes: ["livePush"],
    livePolicy: "actionable", opaqueEndpointRef: "endpoint_old",
    leaseUntil: new Date(Date.now() + 60_000).toISOString() });
  return { service, session, store };
}

function holdBindingWriter(store, sessionId) {
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const held = store.ephemeral.update("deliveryBinding", sessionId, async current => {
    entered();
    await gate;
    return current;
  });
  return { ready, release, held };
}

function nativeAdapter(onBind) {
  return {
    id: "fixture",
    nativeDelivery: { minimumByPlatform: { "darwin-arm64": "1.2.3" },
      anchors: [{ platform: "darwin-arm64", version: "1.2.3", protocolContract: "fixture-v1" }],
      knownBad: [] },
    retireNativeSession: async () => {},
    bindNativeSession: async () => {
      onBind();
      return { supported: true, clientVersion: "1.2.3", protocolContract: "fixture-v1",
        modes: ["livePush"], opaqueEndpointRef: "endpoint_new",
        leaseUntil: new Date(Date.now() + 60_000).toISOString(), reasonCode: null };
    },
  };
}

function bind(adapter, service, session, timeoutMs) {
  return establishNativeBinding({ adapter, event: { sessionId: "harness_receiver", cwd: "/tmp" },
    hookBinding: { accSessionId: session.sessionId, generation: session.generation, clientPid: 42 },
    clientVersion: "1.2.3", platform: "darwin-arm64", livePolicy: "actionable", service,
    runtimeDir: "/private/tmp", clock, timeoutMs });
}

test("a real writer released after the former quarter slice still permits rebinding", async t => {
  // This fails if retirement again divides the native budget into quarter-sized
  // attempts: the 750ms gate exceeds a 500ms quarter slice. The 2000ms budget
  // also leaves room for real holder publication/unlock and retirement I/O.
  const { service, session, store } = await fixture(t);
  const holder = holdBindingWriter(store, session.sessionId);
  await holder.ready;
  let binds = 0;
  const timer = setTimeout(holder.release, 750);
  try {
    const outcome = await bind(nativeAdapter(() => { binds += 1; }), service, session, 2000);
    assert.equal(outcome.state, "active", JSON.stringify(outcome));
    assert.equal(binds, 1);
    assert.equal((await store.ephemeral.get("deliveryBinding", session.sessionId)).opaqueEndpointRef,
      "endpoint_new");
  } finally {
    clearTimeout(timer);
    holder.release();
    await holder.held;
  }
});

test("an expired real writer deadline cannot retire the old endpoint after release", async t => {
  // This fails if a timeout only stops waiting and does not reach the store
  // mutex: the old clear then writes after this hook has already returned.
  const { service, session, store } = await fixture(t);
  const holder = holdBindingWriter(store, session.sessionId);
  await holder.ready;
  let binds = 0;
  const clears = [];
  const observedService = { ...service, clearDeliveryBinding(input) {
    const pending = service.clearDeliveryBinding(input);
    clears.push(pending);
    return pending;
  } };
  const adapter = nativeAdapter(() => { binds += 1; });
  // Exercise the primary clear directly; an optional metadata-read timeout
  // must not let a missing store deadline avoid retiring the old endpoint.
  adapter.retireNativeSession = undefined;
  try {
    const outcome = await bind(adapter, observedService, session, 200);
    assert.equal(outcome.state, "degraded");
    assert.equal(binds, 0);
    assert.equal(clears.length, 1, "the real clear operation must have started");
    holder.release();
    await holder.held;
    await Promise.allSettled(clears);
    const binding = await store.ephemeral.get("deliveryBinding", session.sessionId);
    assert.equal(binding.opaqueEndpointRef, "endpoint_old");
    assert.equal(binding.retiredAt, null);
  } finally {
    holder.release();
    await holder.held;
    await Promise.allSettled(clears);
  }
});
