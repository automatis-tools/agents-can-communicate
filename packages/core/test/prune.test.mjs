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

async function sentMessage(service, from, to, clientMessageId, obligation = "none") {
  return service.sendMessage({ sessionId: from.sessionId, generation: from.generation,
    toParticipantIds: [to], kind: obligation === "reply" ? "question" : "note",
    obligation, subject: "subject", body: "body", clientMessageId });
}

test("a message nobody is owed any more is eligible below the boundary", async t => {
  const { service, prune, store } = makeService();
  const { live, gone } = await workspaceWith(service);
  const sent = await sentMessage(service, gone, "participant_live", "client_settled");
  await service.acknowledgeMessage({ messageId: sent.messageId, sessionId: live.sessionId,
    generation: live.generation });
  const cursor = (await store.eventsSince(WORKSPACE, null, 100)).cursor;

  const plan = await prune.planPrune({ classes: [], before: cursor });

  assert.equal(plan.counts.messages, 1);
  assert.ok(plan.counts.receipts >= 1);
  assert.ok(plan.counts.events > 0);
});

test("a message still owed to someone who is here is kept", async t => {
  const { service, prune, store } = makeService();
  const { gone } = await workspaceWith(service);
  await sentMessage(service, gone, "participant_live", "client_open", "reply");
  const cursor = (await store.eventsSince(WORKSPACE, null, 100)).cursor;

  const plan = await prune.planPrune({ classes: [], before: cursor });

  // Offered is not read and retrieved is not model attention. Only an
  // acknowledged receipt settles the obligation, and its recipient is still
  // here to acknowledge it.
  assert.equal(plan.counts.messages, 0);
  assert.equal(plan.counts.receipts, 0);
});

test("applying a boundary trims the log and reports where it now starts", async t => {
  const { service, prune, store } = makeService();
  await workspaceWith(service);
  const cursor = (await store.eventsSince(WORKSPACE, null, 100)).cursor;

  const result = await prune.prune({ classes: [], before: cursor, apply: true });

  assert.equal(result.trimmedThrough, cursor);
  const page = await store.eventsSince(WORKSPACE, null, 100);
  assert.deepEqual(page.events, []);
  assert.equal(page.trimmedThrough, cursor);
});

test("a boundary that is not a cursor is refused", async t => {
  const { prune } = makeService();

  await assert.rejects(prune.planPrune({ before: "last tuesday" }),
    error => error.code === EXIT.USAGE);
});

test("naming no boundary leaves history alone", async t => {
  const { service, prune, store } = makeService();
  await workspaceWith(service);
  const before = (await store.eventsSince(WORKSPACE, null, 100)).events.length;

  const result = await prune.prune({ apply: true });

  assert.equal(result.trimmedThrough, null);
  assert.equal((await store.eventsSince(WORKSPACE, null, 100)).events.length, before);
});

test("a session still holding a live claim is kept however quiet it is", async t => {
  const { service, prune, clock } = makeService();
  const { live } = await workspaceWith(service);
  await service.acquireClaim({ sessionId: live.sessionId, generation: live.generation,
    resource: "file:src/a.mjs", reason: "editing", leaseSeconds: 7 * 24 * 60 * 60 });
  clock.advance(2 * DAY);

  const plan = await prune.planPrune({ workspaceId: WORKSPACE });

  // The claim names the session that holds it, and that name is how a peer
  // blocked by it finds someone to ask. One of the two sessions is offline and
  // free; the one holding the lease is not.
  assert.equal(plan.counts.sessions, 1);
  assert.equal(plan.counts.claims, 0);
});

test("a session that opens between the report and the apply is not removed", async t => {
  const { service, prune, store, clock } = makeService();
  await workspaceWith(service);
  clock.advance(2 * DAY);
  const reported = await prune.planPrune({ workspaceId: WORKSPACE });
  assert.equal(reported.counts.participants, 2);

  // Eligibility is relational: a participant is eligible because no session of
  // theirs survives. A new session changes that answer without changing any
  // record the report had named, so a generation check cannot catch it. The
  // decision is taken again under the writer mutex, and that reading is the one
  // acted on.
  const fresh = await service.openSession(opening({ participantId: "participant_live" }));
  assert.ok(fresh.sessionId);
  const result = await prune.prune({ workspaceId: WORKSPACE, apply: true });

  assert.equal(result.counts.participants, 1);
  const survivors = (await store.snapshot(WORKSPACE)).participants.map(item => item.participantId);
  assert.deepEqual(survivors, ["participant_live"]);
});

test("asking for participants alone orphans nothing", async t => {
  const { service, prune, store, clock } = makeService();
  await workspaceWith(service);
  clock.advance(2 * DAY);

  const plan = await prune.planPrune({ classes: ["participants"] });

  // Every session stays, so every participant is still pointed at. Removing one
  // anyway would leave its sessions naming a roster entry that is gone.
  assert.equal(plan.counts.participants, 0);
  await prune.prune({ classes: ["participants"], apply: true });
  assert.equal((await store.snapshot(WORKSPACE)).participants.length, 2);
});

test("asking for sessions and participants together removes both", async t => {
  const { service, prune, store, clock } = makeService();
  await workspaceWith(service);
  clock.advance(2 * DAY);

  await prune.prune({ classes: ["sessions", "participants"], apply: true });

  const snapshot = await store.snapshot(WORKSPACE);
  assert.deepEqual(snapshot.sessions, []);
  assert.deepEqual(snapshot.participants, []);
});

test("a pass cut short leaves no record pointing at one that is gone", async t => {
  const { service, prune, store, clock } = makeService();
  const { gone } = await workspaceWith(service);
  await service.setIntent({ sessionId: gone.sessionId, generation: gone.generation,
    summary: "work that stopped", mode: "edit" });
  clock.advance(2 * DAY);

  // What a bounded pass has done when it stops is a prefix of the plan, so the
  // prefix has to be a state the store can be left in. An intent names a
  // session and a session names a participant, so each must go before what it
  // names.
  const plan = await prune.planPrune({ workspaceId: WORKSPACE });
  const position = kind => plan.entries.findIndex(entry => entry.kind === kind);

  assert.ok(position("intent") < position("session"),
    "an intent must be removed before the session it names");
  assert.ok(position("session") < position("participant"),
    "a session must be removed before the participant it names");
  assert.equal((await store.snapshot(WORKSPACE)).intents.length, 1);
});
