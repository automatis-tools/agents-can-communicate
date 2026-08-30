import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { ATTENTION_PRIORITY, computeAttention } from "../src/sync.mjs";
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

  // Solo zero-overhead: no peers, no attention, no
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

test("a peer intending a resource I hold tells me my claim is contended", async () => {
  const { service } = makeService();
  const { first, second } = await pair(service);
  // I hold the claim; a peer declares intent on the same resource. The mirror of
  // the conflict above: there the intent is mine and the claim a peer's; here the
  // claim is mine and the intent a peer's.
  await service.acquireClaim({ sessionId: first.sessionId, generation: first.generation,
    resource: "file:packages/core/src/claims.mjs", reason: "editing" });
  await service.setIntent({ sessionId: second.sessionId, generation: second.generation,
    summary: "reading the claim model", mode: "explore",
    resourceHints: ["file:packages/core/src/claims.mjs"] });

  const result = await service.sync({ sessionId: first.sessionId });

  assert.deepEqual(result.attention.map(item => item.kind), ["claim_contended"]);
  assert.equal(result.attention[0].sourceId.startsWith("claim_"), true,
    "the line carries the claim id, so `acc release --claim` has its argument");
});

test("my own intent over my own claim is not a contention", async () => {
  const { service } = makeService();
  const { first } = await pair(service);
  await service.acquireClaim({ sessionId: first.sessionId, generation: first.generation,
    resource: "file:src/mine.mjs", reason: "editing" });
  await service.setIntent({ sessionId: first.sessionId, generation: first.generation,
    summary: "editing mine", mode: "edit", resourceHints: ["file:src/mine.mjs"] });

  const result = await service.sync({ sessionId: first.sessionId });

  // Declaring intent on what you already hold is not someone reaching for it.
  assert.equal(result.attention.some(item => item.kind === "claim_contended"), false);
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

test("every attention kind in the priority table is one a rule can produce", () => {
  // The guard for a specific failure: a kind listed here with nothing behind
  // it. `nearby_intent` sat in this table with no rule, so it read as a shipped
  // feature in review, was documented as one, and produced nothing at runtime.
  //
  // The snapshot below is built to trigger every rule at once. An entry added to
  // the table without a rule fails this test; one added with a rule fails it
  // until the snapshot exercises it, which is the point.
  const snapshot = {
    messages: [{ messageId: "message_a", subject: "Need slots", requiresAck: true }],
    receipts: [{ messageId: "message_a", recipientParticipantId: "participant_a",
      state: "injected" }],
    intents: [
      { sessionId: "session_a", resourceHints: ["file:src/**"] },
      // A peer heading for what this session holds - triggers claim_contended.
      { sessionId: "session_b", resourceHints: ["file:src/held.mjs"] },
    ],
    claims: [
      { claimId: "claim_a", ownerSessionId: "session_b", resource: "file:src/main.mjs",
        expiresAt: "2026-08-16T02:00:00.000Z" },
      // This session's own, and its lease has run out.
      { claimId: "claim_b", ownerSessionId: "session_a", resource: "file:src/lapsed.mjs",
        expiresAt: "2026-08-16T00:30:00.000Z" },
      // This session's own and still held, and a peer above means to touch it.
      { claimId: "claim_c", ownerSessionId: "session_a", resource: "file:src/held.mjs",
        expiresAt: "2026-08-16T02:00:00.000Z" },
    ],
    tasks: [
      { taskId: "task_a", state: "pending", assigneeSessionId: "session_a",
        title: "port the store" },
      // Taken by a session that then went quiet. The requester is still waiting.
      { taskId: "task_b", state: "in_progress", assigneeSessionId: "session_gone",
        assigneeParticipantId: "physics", requestedByParticipantId: "participant_a",
        title: "tank sinks into mud" },
    ],
    sessions: [{ sessionId: "session_gone", state: "closed",
      heartbeatAt: NOW, heartbeatCadenceMs: 30_000 }],
    workstreams: [{ workstreamId: "workstream_a", state: "open",
      coordinatorSessionId: null, title: "directed-visuals" }],
  };

  const produced = computeAttention(snapshot, { session: { sessionId: "session_a" },
    participantId: "participant_a", now: NOW, pidIsAlive: () => true });

  assert.deepEqual([...new Set(produced.map(item => item.kind))].sort(),
    Object.keys(ATTENTION_PRIORITY).sort());
  // Ordering is the table's, so a new kind cannot quietly outrank a conflict.
  assert.deepEqual(produced.map(item => item.priority),
    [...produced.map(item => item.priority)].sort((left, right) => left - right));
});

test("an empty roster does not let a missing probe through", () => {
  // stalledRequests only reaches classifySessionPresence inside a map/filter
  // over snapshot.sessions, so a snapshot with none to classify must not be
  // the reason a forgotten pidIsAlive goes unnoticed.
  const options = { session: null, participantId: "participant_a", now: NOW };
  assert.throws(() => computeAttention({}, options), error => error.code === EXIT.USAGE);
  assert.throws(() => computeAttention({ sessions: [] }, options),
    error => error.code === EXIT.USAGE);
});
