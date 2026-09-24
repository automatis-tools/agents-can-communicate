import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createPruneService } from "../src/prune.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-24T01:00:00.000Z";
const WORKSPACE = "workspace_a";
const DAY = 24 * 60 * 60 * 1000;

function makeService({ pidIsAlive = () => true } = {}) {
  const clock = createFakeClock(NOW);
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: WORKSPACE });
  const ports = { store, clock, ids: createFakeIds(), pidIsAlive };
  return { clock, store, service: createCoordinationService(ports),
    prune: createPruneService(ports) };
}

const opening = (overrides = {}) => ({ workspaceId: WORKSPACE,
  participantId: "participant_a", displayName: "visual", harness: "codex",
  heartbeatCadenceMs: 30_000, ...overrides });

// Two sessions materialise the workspace, which is where durable records live.
async function workspaceWith(service, extra = {}) {
  const live = await service.openSession(opening({ participantId: "participant_live" }));
  const gone = await service.openSession(opening({ participantId: "participant_gone", ...extra }));
  return { live, gone };
}

test("a plan names offline sessions and leaves live ones alone", async t => {
  const { service, prune, clock } = makeService();
  const { gone } = await workspaceWith(service);
  await service.setIntent({ sessionId: gone.sessionId, generation: gone.generation,
    summary: "work that stopped", mode: "edit" });
  // A full day without a heartbeat is what makes a session offline when no pid
  // settles the question. The live one keeps heartbeating.
  clock.advance(2 * DAY);

  const plan = await prune.planPrune({ workspaceId: WORKSPACE });

  assert.equal(plan.counts.sessions, 2);
  assert.equal(plan.counts.intents, 1);
  assert.equal(plan.entries.every(entry => typeof entry.generation === "string"), true);
});

test("a stale session is not an offline one", async t => {
  const { service, prune, clock } = makeService();
  await workspaceWith(service);
  // Past three heartbeat cadences a session reads `stale`, and a quiet session
  // is still someone's. Only `offline` is a record nobody can come back to.
  clock.advance(5 * 30_000);

  const plan = await prune.planPrune({ workspaceId: WORKSPACE });

  assert.equal(plan.counts.sessions, 0);
});

test("an expired claim is eligible and a live one is not", async t => {
  const { service, prune, clock } = makeService();
  const { live } = await workspaceWith(service);
  await service.acquireClaim({ sessionId: live.sessionId, generation: live.generation,
    resource: "file:src/a.mjs", reason: "editing", leaseSeconds: 60 });

  assert.equal((await prune.planPrune({ classes: ["claims"] })).counts.claims, 0);
  clock.advance(120_000);
  assert.equal((await prune.planPrune({ classes: ["claims"] })).counts.claims, 1);
});

test("a participant named on a surviving message is kept", async t => {
  const { service, prune, clock } = makeService();
  const { live, gone } = await workspaceWith(service);
  await service.sendMessage({ sessionId: gone.sessionId, generation: gone.generation,
    toParticipantIds: ["participant_live"], kind: "note", obligation: "none",
    subject: "before leaving", body: "the parser is ported", clientMessageId: "client_a" });
  clock.advance(2 * DAY);

  const plan = await prune.planPrune({ workspaceId: WORKSPACE });

  // Both participants are named on that message - one sent it, one received it
  // - and the roster is where "who sent this" is answered.
  assert.equal(plan.counts.participants, 0);
  assert.equal(plan.counts.sessions, 2);
});

test("a participant nothing points at any more is eligible", async t => {
  const { service, prune, clock } = makeService();
  await workspaceWith(service);
  clock.advance(2 * DAY);

  const plan = await prune.planPrune({ workspaceId: WORKSPACE });

  assert.equal(plan.counts.participants, 2);
});

test("a prune reports what it would do and changes nothing", async t => {
  const { service, prune, store, clock } = makeService();
  await workspaceWith(service);
  clock.advance(2 * DAY);
  const before = (await store.snapshot(WORKSPACE)).sessions.length;

  const result = await prune.prune({ workspaceId: WORKSPACE });

  // The dry run is the default, because this is the one command that takes
  // records out of the store.
  assert.equal(result.applied, false);
  assert.equal(result.reclaimed, 0);
  assert.equal((await store.snapshot(WORKSPACE)).sessions.length, before);
});

test("applying a prune removes exactly what the plan named", async t => {
  const { service, prune, store, clock } = makeService();
  await workspaceWith(service);
  clock.advance(2 * DAY);
  const plan = await prune.planPrune({ workspaceId: WORKSPACE });

  const result = await prune.prune({ workspaceId: WORKSPACE, apply: true });

  assert.equal(result.applied, true);
  assert.equal(result.reclaimed, plan.entries.length);
  assert.equal(result.skipped, 0);
  assert.deepEqual((await store.snapshot(WORKSPACE)).sessions, []);
});

test("an unknown class is refused rather than ignored", async t => {
  const { prune } = makeService();

  await assert.rejects(prune.planPrune({ classes: ["everything"] }),
    error => error.code === EXIT.USAGE);
});
