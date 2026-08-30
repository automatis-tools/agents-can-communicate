import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { classifySessionPresence } from "../src/sessions.mjs";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";
const CADENCE = 30_000;

function makeService(overrides = {}) {
  const clock = createFakeClock(NOW);
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: WORKSPACE });
  return { clock, store,
    service: createCoordinationService({ store, clock, ids: createFakeIds(), ...overrides }) };
}

const opening = (overrides = {}) => ({ workspaceId: WORKSPACE, participantId: "participant_a",
  displayName: "visual", harness: "codex", heartbeatCadenceMs: CADENCE, ...overrides });

test("a lone session leaves only ephemeral state behind", async () => {
  const { service, store } = makeService();

  const session = await service.openSession(opening());

  // Approved 2026-08-15: attachment is universal, durable state is not created
  // merely because one session opened somewhere.
  assert.equal(session.state, "open");
  assert.equal((await store.snapshot(WORKSPACE)).workspace, null);
  assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events, []);
  assert.equal((await store.ephemeral.list("session")).length, 1);
});

test("closing the only session of an ephemeral workspace leaves nothing", async () => {
  const { service, store } = makeService();
  const session = await service.openSession(opening());

  await service.closeSession({ sessionId: session.sessionId, generation: session.generation });

  assert.deepEqual(await store.ephemeral.list("session"), []);
  assert.equal((await store.snapshot(WORKSPACE)).workspace, null);
  assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events, []);
});

test("a second live session materialises the workspace exactly once", async () => {
  const { service, store } = makeService();
  const first = await service.openSession(opening());
  await service.setIntent({ sessionId: first.sessionId, generation: first.generation,
    summary: "reading the claim model", mode: "review" });

  const second = await service.openSession(opening({ participantId: "participant_b",
    displayName: "models", harness: "claude-code" }));

  const snapshot = await store.snapshot(WORKSPACE);
  assert.notEqual(snapshot.workspace, null, "the workspace did not materialise");
  assert.deepEqual(snapshot.sessions.map(item => item.sessionId).sort(),
    [first.sessionId, second.sessionId].sort());
  // The Intent that existed only ephemerally is recorded durably at that moment.
  assert.deepEqual(snapshot.intents.map(item => item.summary), ["reading the claim model"]);
  assert.deepEqual(await store.ephemeral.list("session"), []);

  const types = (await store.eventsSince(WORKSPACE, null, 20)).events.map(event => event.type);
  assert.equal(types.filter(type => type === "workspace.materialised").length, 1);
});

test("materialisation happens once, not on every later session", async () => {
  const { service, store } = makeService();
  await service.openSession(opening());
  await service.openSession(opening({ participantId: "participant_b", displayName: "models" }));
  const before = (await store.eventsSince(WORKSPACE, null, 50)).events.length;

  await service.openSession(opening({ participantId: "participant_c", displayName: "ops" }));

  const types = (await store.eventsSince(WORKSPACE, null, 50)).events.map(event => event.type);
  assert.equal(types.filter(type => type === "workspace.materialised").length, 1);
  assert.equal(types.length > before, true, "the third session appended no event");
});

test("every session generation is unique", async () => {
  const { service } = makeService();

  const first = await service.openSession(opening());
  const second = await service.openSession(opening({ participantId: "participant_b" }));

  assert.notEqual(first.generation, second.generation);
  assert.notEqual(first.sessionId, second.sessionId);
});

test("reopening a live session id is a conflict", async () => {
  const { service } = makeService();
  const session = await service.openSession(opening());

  await assert.rejects(service.openSession(opening({ sessionId: session.sessionId })),
    error => error.code === EXIT.CONFLICT);
});

test("a stale session cannot be replaced without a liveness probe", async () => {
  const { service, clock } = makeService();
  const session = await service.openSession(opening());
  clock.advance(CADENCE * 10);

  // Approved model: presence staleness alone never replaces ownership, because
  // an idle-but-open session may resume at any moment.
  await assert.rejects(service.openSession(opening({ sessionId: session.sessionId })),
    error => error.code === EXIT.CONFLICT);

  const replaced = await service.openSession(opening({ sessionId: session.sessionId,
    probe: () => false }));
  assert.notEqual(replaced.generation, session.generation);
});

test("a session whose recorded pid is dead is replaceable with no explicit probe", async () => {
  const { service, store } = makeService({ pidIsAlive: () => false });
  const session = await service.openSession(opening());
  // Task 1 does not let openSession write a pid (Task 2 adds the field to the
  // schema); patching the ephemeral record directly simulates what a later
  // task's hook will actually record.
  const raw = await store.ephemeral.get("session", session.sessionId);
  await store.ephemeral.put("session", session.sessionId, { ...raw, pid: 42 });

  const replaced = await service.openSession(opening({ sessionId: session.sessionId }));
  assert.notEqual(replaced.generation, session.generation);
});

test("a session with no pid is never replaceable by age alone", async () => {
  const { service, clock } = makeService();
  const session = await service.openSession(opening());
  // 100 minutes - well past the 30-minute unknown floor: if age alone still
  // governed replacement here, this session would already read as offline and
  // this would silently succeed instead of pinning the ruling.
  clock.advance(CADENCE * 200);

  await assert.rejects(service.openSession(opening({ sessionId: session.sessionId })),
    error => error.code === EXIT.CONFLICT);
});

test("an old generation cannot close its successor", async () => {
  const { service } = makeService();
  const original = await service.openSession(opening());
  const successor = await service.openSession(opening({ sessionId: original.sessionId,
    probe: () => false }));

  await assert.rejects(service.closeSession({ sessionId: original.sessionId,
    generation: original.generation }), error => error.code === EXIT.CONFLICT);

  const closed = await service.closeSession({ sessionId: successor.sessionId,
    generation: successor.generation });
  assert.equal(closed.state, "closed");
});

test("a heartbeat requires the exact generation and moves only presence", async () => {
  const { service, store, clock } = makeService();
  const first = await service.openSession(opening());
  await service.openSession(opening({ participantId: "participant_b" }));
  const before = (await store.eventsSince(WORKSPACE, null, 50)).events.length;
  clock.advance(1_000);

  const beaten = await service.heartbeatSession({ sessionId: first.sessionId,
    generation: first.generation });

  assert.notEqual(beaten.heartbeatAt, first.heartbeatAt);
  // Heartbeats update an ephemeral presence view rather than flooding the
  // semantic event feed (spec section 6.4).
  assert.equal((await store.eventsSince(WORKSPACE, null, 50)).events.length, before);
  await assert.rejects(service.heartbeatSession({ sessionId: first.sessionId,
    generation: "generation_wrong" }), error => error.code === EXIT.CONFLICT);
});

test("presence is classified from the session's own declared cadence", () => {
  const session = { state: "open", heartbeatAt: NOW, heartbeatCadenceMs: CADENCE };
  const alive = () => true;
  const at = offset => new Date(Date.parse(NOW) + offset).toISOString();

  assert.equal(classifySessionPresence(session, at(CADENCE), alive), "online");
  assert.equal(classifySessionPresence(session, at(CADENCE * 3 + 1), alive), "stale");
  assert.equal(classifySessionPresence({ ...session, heartbeatCadenceMs: CADENCE * 10 },
    at(CADENCE * 3 + 1), alive), "online");
});

test("a closed session or a failed probe is offline, never merely stale", () => {
  const session = { state: "open", heartbeatAt: NOW, heartbeatCadenceMs: CADENCE };
  const at = offset => new Date(Date.parse(NOW) + offset).toISOString();

  assert.equal(classifySessionPresence({ ...session, state: "closed" }, NOW,
    () => true), "offline");
  assert.equal(classifySessionPresence({ ...session, pid: 42 }, at(CADENCE * 99), () => false),
    "offline");
});

test("stale is a truthful state, not an error", () => {
  // A hook-only adapter cannot heartbeat while the harness is idle, so stale is
  // the expected display for an open session between turns.
  const session = { state: "open", heartbeatAt: NOW, heartbeatCadenceMs: CADENCE };
  const later = new Date(Date.parse(NOW) + CADENCE * 5).toISOString();

  assert.equal(classifySessionPresence(session, later, () => true), "stale");
});

test("a session records the process behind it, or null when nobody knows", async () => {
  const { service } = makeService();

  const known = await service.openSession(opening({ pid: 4321 }));
  const unknown = await service.openSession(opening({ participantId: "participant_b",
    pid: undefined }));

  // null is a first-class answer here, not a missing value: it is what the
  // ancestry walk returns when it cannot name the client.
  assert.equal(known.pid, 4321);
  assert.equal(unknown.pid, null);
});
