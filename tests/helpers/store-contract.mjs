import assert from "node:assert/strict";
import test from "node:test";
import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";
import { ZERO_CURSOR } from "./memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";

const workspaceRecord = () => ({ schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE,
  displayName: "Example", source: "directory", roots: ["/tmp/example"], createdAt: NOW });

const eventRecord = (type, overrides = {}) => ({ schemaVersion: SCHEMA_VERSION,
  eventId: `event_${type.replace(".", "_")}`, workspaceId: WORKSPACE,
  actorSessionId: "session_a", type, occurredAt: NOW, payload: {}, ...overrides });

const sessionRecord = (overrides = {}) => ({ schemaVersion: SCHEMA_VERSION,
  sessionId: "session_a", participantId: "participant_a", workspaceId: WORKSPACE,
  generation: "generation_semantic", harness: "codex", state: "open",
  parentSessionId: null, checkoutRoot: null, branch: null, pid: null,
  enforcement: "advisory", lifecycle: "manual", heartbeatCadenceMs: 30_000,
  startedAt: NOW, heartbeatAt: NOW, ...overrides });

// Exported so every CoordinationStore implementation is held to the same
// contract. A contract only one implementation satisfies proves nothing.
export function runStoreContract(name, makeStore) {
  test(`${name}: one state record is read by id, with every check a listing applies`, async () => {
    // A session lookup used to list every session to find one, which a hook
    // did many times over: in a long-lived workspace that alone outran the
    // five-second hook budget.
    const store = await makeStore();
    const other = sessionRecord({ sessionId: "session_b", participantId: "participant_b" });
    await store.transaction(async tx => {
      tx.put("workspace", WORKSPACE, workspaceRecord());
      tx.put("session", "session_a", sessionRecord());
      tx.put("session", "session_b", other);
      tx.append(eventRecord("workspace.materialised"));
    });

    assert.deepEqual(await store.stateRecord(WORKSPACE, "session", "session_b"), other);
    assert.equal(await store.stateRecord(WORKSPACE, "session", "session_missing"), null);
    assert.equal(await store.stateRecord("workspace_other", "session", "session_a"), null,
      "a record of another workspace is not this workspace's");

    await store.transaction(async tx => {
      tx.remove("session", "session_a", tx.generationOf("session", "session_a"));
      tx.append(eventRecord("session.closed"));
    });
    assert.equal(await store.stateRecord(WORKSPACE, "session", "session_a"), null,
      "a removed record is absent, as it is from a listing");
    assert.deepEqual((await store.snapshot(WORKSPACE, { kinds: ["session"] })).sessions, [other]);
  });

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

  test(`${name}: ephemeral updates serialize read-modify-write`, async () => {
    const store = await makeStore();
    await store.ephemeral.put("session", "session_a", sessionRecord());
    const first = "2026-08-16T01:00:01.000Z";
    const second = "2026-08-16T01:00:02.000Z";
    const advance = current => ({ ...current,
      heartbeatAt: current.heartbeatAt === NOW ? first : second });

    const results = await Promise.all([
      store.ephemeral.update("session", "session_a", advance),
      store.ephemeral.update("session", "session_a", advance),
    ]);

    assert.deepEqual(results.map(record => record.heartbeatAt).sort(), [first, second]);
    assert.equal((await store.ephemeral.get("session", "session_a")).heartbeatAt, second);
  });

  test(`${name}: ephemeral put and delete wait for an update holding the lock`, async () => {
    const store = await makeStore();
    const pauseUpdate = async next => {
      let entered;
      let release;
      const inside = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const update = store.ephemeral.update("session", "session_a", async current => {
        entered();
        await gate;
        return next(current);
      });
      await inside;
      return { update, release };
    };
    const letItRun = () => new Promise(resolve => setImmediate(resolve));
    await store.ephemeral.put("session", "session_a", sessionRecord());

    const beforePut = await pauseUpdate(current => ({ ...current,
      heartbeatAt: "2026-08-16T01:00:01.000Z" }));
    let putSettled = false;
    const replacement = sessionRecord({ generation: "generation_replacement" });
    const put = store.ephemeral.put("session", "session_a", replacement)
      .then(() => { putSettled = true; });
    await letItRun();
    assert.equal(putSettled, false, "put bypassed an update holding the writer lock");
    beforePut.release();
    await Promise.all([beforePut.update, put]);
    assert.equal((await store.ephemeral.get("session", "session_a")).generation,
      "generation_replacement");

    const beforeDelete = await pauseUpdate(current => ({ ...current,
      heartbeatAt: "2026-08-16T01:00:02.000Z" }));
    let deleteSettled = false;
    const deletion = store.ephemeral.delete("session", "session_a")
      .then(() => { deleteSettled = true; });
    await letItRun();
    assert.equal(deleteSettled, false, "delete bypassed an update holding the writer lock");
    beforeDelete.release();
    await Promise.all([beforeDelete.update, deletion]);
    assert.equal(await store.ephemeral.get("session", "session_a"), null);
  });
}
