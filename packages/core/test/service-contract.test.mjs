import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

import { runStoreContract } from "../../../tests/helpers/store-contract.mjs";

const NOW = "2026-08-16T01:00:00.000Z";


runStoreContract("memory", async () =>
  createMemoryStore({ clock: createFakeClock(NOW), ids: createFakeIds() }));

test("the service factory refuses to run on ambient time or randomness", () => {
  const store = createMemoryStore({ clock: createFakeClock(NOW), ids: createFakeIds() });

  assert.throws(() => createCoordinationService({ store, ids: createFakeIds() }),
    error => error.code === EXIT.USAGE && error.message.includes("clock"));
  assert.throws(() => createCoordinationService({ store, clock: createFakeClock(NOW) }),
    error => error.code === EXIT.USAGE && error.message.includes("ids"));
  assert.throws(() => createCoordinationService({ clock: createFakeClock(NOW),
    ids: createFakeIds() }), error => error.code === EXIT.USAGE
    && error.message.includes("store"));
});

test("the service factory rejects a port missing a required method", () => {
  assert.throws(() => createCoordinationService({
    store: { transaction: async () => {}, eventsSince: async () => {} },
    clock: createFakeClock(NOW),
    ids: createFakeIds(),
  }), error => error.code === EXIT.USAGE && error.message.includes("snapshot"));
});

test("a pidIsAlive that is not a function is refused at construction", () => {
  const store = createMemoryStore({ clock: createFakeClock(NOW), ids: createFakeIds() });

  // Not shape-checking this port let it construct cleanly and die later with a
  // bare TypeError the first time presence was classified - invisible to the
  // CLI's exit-code mapping. `null` is checked separately from a missing value:
  // the default only applies to `undefined`, so an explicit `null` would
  // otherwise slip through untouched.
  assert.throws(() => createCoordinationService({ store, clock: createFakeClock(NOW),
    ids: createFakeIds(), pidIsAlive: true }),
  error => error.code === EXIT.USAGE && error.message.includes("pidIsAlive"));
  assert.throws(() => createCoordinationService({ store, clock: createFakeClock(NOW),
    ids: createFakeIds(), pidIsAlive: null }),
  error => error.code === EXIT.USAGE && error.message.includes("pidIsAlive"));
});

test("the service exposes frozen ports and no global singleton", () => {
  const store = createMemoryStore({ clock: createFakeClock(NOW), ids: createFakeIds() });
  const service = createCoordinationService({ store, clock: createFakeClock(NOW),
    ids: createFakeIds() });

  assert.equal(Object.isFrozen(service), true);
  assert.throws(() => { service.store = null; }, TypeError);
  assert.notEqual(service, createCoordinationService({ store, clock: createFakeClock(NOW),
    ids: createFakeIds() }));
});

test("policies default to an empty frozen set rather than undefined", () => {
  const store = createMemoryStore({ clock: createFakeClock(NOW), ids: createFakeIds() });
  const service = createCoordinationService({ store, clock: createFakeClock(NOW),
    ids: createFakeIds() });

  assert.deepEqual(service.policies, {});
  assert.equal(Object.isFrozen(service.policies), true);
});
