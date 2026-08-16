import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

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

async function twoSessions(service) {
  const first = await service.openSession(opening());
  const second = await service.openSession(opening({ participantId: "participant_b",
    displayName: "models" }));
  return { first, second };
}

test("intent is attached to the exact session generation that published it", async () => {
  const { service } = makeService();
  const { first } = await twoSessions(service);

  const intent = await service.setIntent({ sessionId: first.sessionId,
    generation: first.generation, summary: "porting claims", mode: "edit" });

  assert.equal(intent.sessionId, first.sessionId);
  await assert.rejects(service.setIntent({ sessionId: first.sessionId,
    generation: "generation_wrong", summary: "impersonating", mode: "edit" }),
  error => error.code === EXIT.CONFLICT);
});

test("a closed session cannot publish intent", async () => {
  const { service } = makeService();
  const { first } = await twoSessions(service);
  await service.closeSession({ sessionId: first.sessionId, generation: first.generation });

  await assert.rejects(service.setIntent({ sessionId: first.sessionId,
    generation: first.generation, summary: "after the end", mode: "edit" }),
  error => error.code === EXIT.CONFLICT);
});

test("intent carries no raw prompt or transcript field", async () => {
  const { service } = makeService();
  const { first } = await twoSessions(service);

  const intent = await service.setIntent({ sessionId: first.sessionId,
    generation: first.generation, summary: "reviewing", mode: "review",
    prompt: "the user's raw words", transcript: ["turn one"] });

  // Raw transcripts are not collected by default, so unknown input simply does
  // not reach the record rather than being stored under another name.
  assert.equal("prompt" in intent, false);
  assert.equal("transcript" in intent, false);
  assert.deepEqual(Object.keys(intent).sort(), ["mode", "resourceHints", "schemaVersion",
    "sessionId", "state", "summary", "updatedAt", "workspaceId", "workstreamId"]);
});

test("an unknown mode or state is rejected", async () => {
  const { service } = makeService();
  const { first } = await twoSessions(service);
  const base = { sessionId: first.sessionId, generation: first.generation, summary: "x" };

  await assert.rejects(service.setIntent({ ...base, mode: "meditate" }),
    error => error.code === EXIT.DATA);
  await assert.rejects(service.setIntent({ ...base, mode: "edit", state: "vibing" }),
    error => error.code === EXIT.DATA);
});

test("resource hints are advisory URIs, not reservations", async () => {
  const { service, store } = makeService();
  const { first } = await twoSessions(service);

  const intent = await service.setIntent({ sessionId: first.sessionId,
    generation: first.generation, summary: "editing the store", mode: "edit",
    resourceHints: ["file:packages/core/src/sessions.mjs"] });

  assert.deepEqual(intent.resourceHints, ["file:packages/core/src/sessions.mjs"]);
  // A hint never becomes a claim: the claim set stays empty.
  assert.deepEqual((await store.snapshot(WORKSPACE)).claims, []);
  await assert.rejects(service.setIntent({ sessionId: first.sessionId,
    generation: first.generation, summary: "x", mode: "edit",
    resourceHints: ["packages/core"] }), error => error.code === EXIT.DATA);
});

test("a lone session's intent stays ephemeral", async () => {
  const { service, store } = makeService();
  const session = await service.openSession(opening());

  await service.setIntent({ sessionId: session.sessionId, generation: session.generation,
    summary: "alone", mode: "explore" });

  assert.equal((await store.ephemeral.list("intent")).length, 1);
  assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events, []);
  assert.equal((await store.snapshot(WORKSPACE)).workspace, null);
});

test("publishing intent in a materialised workspace appends one event", async () => {
  const { service, store } = makeService();
  const { first } = await twoSessions(service);
  const before = (await store.eventsSince(WORKSPACE, null, 50)).events.length;

  await service.setIntent({ sessionId: first.sessionId, generation: first.generation,
    summary: "porting claims", mode: "edit" });

  const events = (await store.eventsSince(WORKSPACE, null, 50)).events;
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).type, "intent.published");
  assert.equal(events.at(-1).actorSessionId, first.sessionId);
});

test("clearing intent marks it done rather than erasing the history", async () => {
  const { service, store } = makeService();
  const { first } = await twoSessions(service);
  await service.setIntent({ sessionId: first.sessionId, generation: first.generation,
    summary: "porting claims", mode: "edit" });

  await service.clearIntent({ sessionId: first.sessionId, generation: first.generation });

  const snapshot = await store.snapshot(WORKSPACE);
  assert.equal(snapshot.intents.length, 1);
  assert.equal(snapshot.intents[0].state, "done");
  assert.equal((await store.eventsSince(WORKSPACE, null, 50)).events.at(-1).type,
    "intent.cleared");
});

test("an intent summary is bounded and non-empty", async () => {
  const { service } = makeService();
  const { first } = await twoSessions(service);
  const base = { sessionId: first.sessionId, generation: first.generation, mode: "edit" };

  await assert.rejects(service.setIntent({ ...base, summary: "" }),
    error => error.code === EXIT.DATA);
  await assert.rejects(service.setIntent({ ...base, summary: "x".repeat(281) }),
    error => error.code === EXIT.DATA);
});
