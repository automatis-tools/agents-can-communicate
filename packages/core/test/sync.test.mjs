import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";

function makeService() {
  const clock = createFakeClock(NOW);
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: WORKSPACE });
  return { clock, store,
    service: createCoordinationService({ store, clock, ids: createFakeIds() }) };
}

const opening = (overrides = {}) => ({ workspaceId: WORKSPACE, participantId: "participant_a",
  displayName: "visual", harness: "codex", heartbeatCadenceMs: 30_000, ...overrides });

async function pair(service) {
  const first = await service.openSession(opening());
  const second = await service.openSession(opening({ participantId: "participant_b",
    displayName: "models" }));
  return { first, second };
}

test("a solo session syncs to silence", async () => {
  const { service } = makeService();
  const session = await service.openSession(opening());

  const result = await service.sync({ sessionId: session.sessionId });

  // Solo zero-overhead (approved 2026-08-15): no peers, no attention, no
  // claims. The adapter injects zero bytes, not a "nothing to report" banner.
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

  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].type, "intent.published");
  const drained = await service.sync({ sessionId: first.sessionId, cursor: next.cursor });
  assert.deepEqual(drained.events, []);
});

test("full scope returns the whole workspace to any session", async () => {
  const { service } = makeService();
  const { first, second } = await pair(service);
  await service.openSession(opening({ participantId: "participant_c",
    parentSessionId: second.sessionId, displayName: "child" }));

  const full = await service.sync({ sessionId: first.sessionId, scope: "full" });

  // Peer equality: knowledge is symmetric. A session sees another
  // participant's collapsed child, not a reduced view of it.
  assert.equal(full.scope, "full");
  assert.equal(full.snapshot.sessions.length, 3);
  assert.equal(full.roster.some(item => item.parentSessionId === second.sessionId), true);
});

test("the delta scope omits the snapshot", async () => {
  const { service } = makeService();
  const { first } = await pair(service);

  const delta = await service.sync({ sessionId: first.sessionId });

  assert.equal(delta.scope, "delta");
  assert.equal("snapshot" in delta, false);
});

test("attention ranks a direct request above a nearby claim conflict", async () => {
  const { service } = makeService();
  const { first, second } = await pair(service);
  await service.setIntent({ sessionId: second.sessionId, generation: second.generation,
    summary: "editing claims", mode: "edit",
    resourceHints: ["file:packages/core/src/claims.mjs"] });
  await service.acquireClaim({ sessionId: first.sessionId, generation: first.generation,
    resource: "file:packages/core/src/claims.mjs", reason: "editing" });
  await service.sendMessage({ sessionId: first.sessionId, generation: first.generation,
    toParticipantIds: ["participant_b"], type: "question", subject: "Need slots",
    body: "Which names?", requiresAck: true });

  const result = await service.sync({ sessionId: second.sessionId });

  assert.deepEqual(result.attention.map(item => item.kind),
    ["direct_request", "claim_conflict"]);
});

test("an acknowledged request stops demanding attention", async () => {
  const { service } = makeService();
  const { first, second } = await pair(service);
  const message = await service.sendMessage({ sessionId: first.sessionId,
    generation: first.generation, toParticipantIds: ["participant_b"], type: "question",
    subject: "Need slots", body: "Which names?", requiresAck: true });

  await service.markDelivery({ sessionId: second.sessionId, generation: second.generation,
    messageId: message.messageId, recipientParticipantId: "participant_b",
    state: "acknowledged" });

  const result = await service.sync({ sessionId: second.sessionId });
  assert.deepEqual(result.attention.filter(item => item.kind === "direct_request"), []);
});

test("a message that needs no acknowledgement is not an attention item", async () => {
  const { service } = makeService();
  const { first, second } = await pair(service);
  await service.sendMessage({ sessionId: first.sessionId, generation: first.generation,
    toParticipantIds: ["participant_b"], type: "note", subject: "FYI", body: "context" });

  const result = await service.sync({ sessionId: second.sessionId });

  assert.deepEqual(result.attention.filter(item => item.kind === "direct_request"), []);
});
