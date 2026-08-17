import assert from "node:assert/strict";
import test from "node:test";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore, ZERO_CURSOR }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";

const workspaceRecord = () => ({ schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE,
  displayName: "Example", source: "directory", roots: ["/tmp/example"], createdAt: NOW });

const eventRecord = (type, overrides = {}) => ({ schemaVersion: SCHEMA_VERSION,
  eventId: `event_${type.replace(".", "_")}`, workspaceId: WORKSPACE,
  actorSessionId: "session_a", type, occurredAt: NOW, payload: {}, ...overrides });

// Exported so every CoordinationStore implementation is held to the same
// contract. A contract only one implementation satisfies proves nothing.
export function runStoreContract(name, makeStore) {
  test(`${name}: a committed transaction publishes both record and event`, async () => {
    const store = await makeStore();

    await store.transaction(async tx => {
      tx.put("workspace", WORKSPACE, workspaceRecord());
      tx.append(eventRecord("workspace.materialised"));
    });

    const page = await store.eventsSince(WORKSPACE, null, 10);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].type, "workspace.materialised");
    assert.equal((await store.snapshot(WORKSPACE)).workspace.displayName, "Example");
  });

  test(`${name}: transaction rollback hides state and events`, async () => {
    const store = await makeStore();
    const boom = new Error("synthetic failure after staging");

    await assert.rejects(store.transaction(async tx => {
      tx.put("workspace", WORKSPACE, workspaceRecord());
      tx.append(eventRecord("workspace.materialised"));
      throw boom;
    }), boom);

    assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events, []);
    assert.equal((await store.snapshot(WORKSPACE)).workspace, null);
  });

  test(`${name}: stale generation write fails with EXIT.CONFLICT`, async () => {
    const store = await makeStore();
    await store.transaction(async tx => {
      tx.put("workspace", WORKSPACE, workspaceRecord());
      tx.append(eventRecord("workspace.materialised"));
    });
    const generationA = await store.transaction(async tx => tx.generationOf("workspace", WORKSPACE));

    await store.transaction(async tx => {
      tx.put("workspace", WORKSPACE, { ...workspaceRecord(), displayName: "B" }, generationA);
    });

    await assert.rejects(store.transaction(async tx => {
      tx.put("workspace", WORKSPACE, { ...workspaceRecord(), displayName: "C" }, generationA);
      tx.append(eventRecord("session.opened"));
    }), error => error.code === EXIT.CONFLICT);

    assert.equal((await store.snapshot(WORKSPACE)).workspace.displayName, "B");
    assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events.map(e => e.type),
      ["workspace.materialised"]);
  });

  test(`${name}: creating an existing record without an expectation conflicts`, async () => {
    const store = await makeStore();
    await store.transaction(async tx => { tx.put("workspace", WORKSPACE, workspaceRecord()); });

    await assert.rejects(store.transaction(async tx => {
      tx.put("workspace", WORKSPACE, workspaceRecord());
    }), error => error.code === EXIT.CONFLICT);
  });

  test(`${name}: event sequences are gapless, ordered, and lexicographically sortable`, async () => {
    const store = await makeStore();
    for (const index of [1, 2, 3]) {
      await store.transaction(async tx => {
        tx.append(eventRecord("session.opened", { eventId: `event_open_${index}` }));
      });
    }

    const { events } = await store.eventsSince(WORKSPACE, null, 10);
    const sequences = events.map(event => event.sequence);

    assert.deepEqual(sequences, [...sequences].sort());
    assert.deepEqual(sequences.map(Number), [1, 2, 3]);
    assert.equal(new Set(sequences).size, 3);
  });

  test(`${name}: eventsSince honours the cursor and the limit`, async () => {
    const store = await makeStore();
    for (const index of [1, 2, 3]) {
      await store.transaction(async tx => {
        tx.append(eventRecord("session.opened", { eventId: `event_open_${index}` }));
      });
    }

    const first = await store.eventsSince(WORKSPACE, null, 2);
    assert.equal(first.events.length, 2);

    const second = await store.eventsSince(WORKSPACE, first.cursor, 10);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].eventId, "event_open_3");

    const drained = await store.eventsSince(WORKSPACE, second.cursor, 10);
    assert.deepEqual(drained.events, []);
    assert.equal(drained.cursor, second.cursor);
  });

  test(`${name}: an empty log reports the zero cursor rather than failing`, async () => {
    const store = await makeStore();
    const page = await store.eventsSince(WORKSPACE, null, 10);

    assert.deepEqual(page.events, []);
    assert.equal(page.cursor, ZERO_CURSOR);
  });

  test(`${name}: a rejected record never reaches storage`, async () => {
    const store = await makeStore();

    await assert.rejects(store.transaction(async tx => {
      tx.put("workspace", WORKSPACE, { ...workspaceRecord(), createdAt: "yesterday" });
    }), error => error.code === EXIT.DATA);

    assert.equal((await store.snapshot(WORKSPACE)).workspace, null);
  });

  test(`${name}: another workspace's events stay out of this cursor`, async () => {
    const store = await makeStore();
    await store.transaction(async tx => {
      tx.append(eventRecord("session.opened"));
      tx.append(eventRecord("session.opened", { eventId: "event_other",
        workspaceId: "workspace_b" }));
    });

    const page = await store.eventsSince(WORKSPACE, null, 10);
    assert.deepEqual(page.events.map(event => event.eventId), ["event_session_opened"]);
  });
}

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
