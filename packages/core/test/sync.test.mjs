import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-01T20:00:00.000Z";
const WORKSPACE = "workspace_sync";

function makeService() {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  return { service: createCoordinationService({ store, clock, ids }) };
}

const opening = (participantId, overrides = {}) => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 30_000, ...overrides });

async function pair(service) {
  const first = await service.openSession(opening("participant_a"));
  const second = await service.openSession(opening("participant_b"));
  return { first, second };
}

test("a solo session syncs to silence", async () => {
  const { service } = makeService();
  const session = await service.openSession(opening("participant_a"));

  const result = await service.sync({ sessionId: session.sessionId });

  assert.equal(result.solo, true);
  assert.deepEqual(result.attention, []);
  assert.deepEqual(result.events, []);
});

test("a second session ends the solo state", async () => {
  const { service } = makeService();
  const { first } = await pair(service);

  const result = await service.sync({ sessionId: first.sessionId });

  assert.equal(result.solo, false);
  assert.equal(result.roster.length, 2);
  assert.equal(result.roster.every(item => item.presence === "online"), true);
});

test("the cursor advances and replays nothing already consumed", async () => {
  const { service } = makeService();
  const { first } = await pair(service);
  const initial = await service.sync({ sessionId: first.sessionId });
  await service.setIntent({ sessionId: first.sessionId, generation: first.generation,
    summary: "porting", mode: "edit" });

  const next = await service.sync({ sessionId: first.sessionId, cursor: initial.cursor });

  assert.deepEqual(next.events.map(item => item.type), ["intent.published"]);
  assert.deepEqual((await service.sync({ sessionId: first.sessionId,
    cursor: next.cursor })).events, []);
});

test("full scope returns the complete v0.2 workspace to any participant", async () => {
  const { service } = makeService();
  const { first, second } = await pair(service);
  await service.openSession(opening("participant_c", { parentSessionId: second.sessionId }));

  const full = await service.sync({ sessionId: first.sessionId, scope: "full" });

  assert.equal(full.scope, "full");
  assert.equal(full.snapshot.sessions.length, 3);
  assert.deepEqual(Object.keys(full.snapshot).sort(), ["claims", "intents", "messages",
    "participants", "receipts", "sessions", "workspace"]);
  assert.equal(full.roster.some(item => item.parentSessionId === second.sessionId), true);
});

test("delta scope omits the snapshot", async () => {
  const { service } = makeService();
  const { first } = await pair(service);

  const delta = await service.sync({ sessionId: first.sessionId });

  assert.equal(delta.scope, "delta");
  assert.equal("snapshot" in delta, false);
});

test("sync surfaces the recipient's unresolved reply obligation", async () => {
  const { service } = makeService();
  const { first, second } = await pair(service);
  await service.sendMessage({ sessionId: first.sessionId, generation: first.generation,
    clientMessageId: "client_sync", toParticipantIds: ["participant_b"],
    kind: "question", obligation: "reply", subject: "Need slots", body: "Which names?" });

  const result = await service.sync({ sessionId: second.sessionId });

  assert.deepEqual(result.attention.map(item => item.kind), ["reply_required"]);
});
