import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { overlaps } from "../src/claims.mjs";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";
const RESOURCE = "file:packages/core/src/claims.mjs";

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

const claiming = (session, overrides = {}) => ({ sessionId: session.sessionId,
  generation: session.generation, resource: RESOURCE, mode: "exclusive",
  enforcement: "advisory", reason: "editing", leaseSeconds: 1800, ...overrides });

test("resource overlap covers exact matches and glob prefixes", () => {
  assert.equal(overlaps("file:a/b.mjs", "file:a/b.mjs"), true);
  assert.equal(overlaps("file:a/b.mjs", "file:a/c.mjs"), false);
  assert.equal(overlaps("file:a/**", "file:a/b/c.mjs"), true);
  assert.equal(overlaps("file:a/b/c.mjs", "file:a/**"), true);
  // Different schemes never overlap, and a name prefix is not a path prefix.
  assert.equal(overlaps("file:a/**", "git:a/b"), false);
  assert.equal(overlaps("file:a/**", "file:ab/c.mjs"), false);
});

test("an exclusive claim blocks a second claimant on the same resource", async () => {
  const { service } = makeService();
  const { first, second } = await twoSessions(service);
  await service.acquireClaim(claiming(first));

  await assert.rejects(service.acquireClaim(claiming(second)),
    error => error.code === EXIT.CONFLICT);
});

test("shared claims coexist while an exclusive claim excludes everything", async () => {
  const { service } = makeService();
  const { first, second } = await twoSessions(service);
  await service.acquireClaim(claiming(first, { mode: "shared" }));

  const shared = await service.acquireClaim(claiming(second, { mode: "shared" }));
  assert.equal(shared.mode, "shared");

  await assert.rejects(service.acquireClaim(claiming(second, { mode: "exclusive" })),
    error => error.code === EXIT.CONFLICT);
});

test("claims are workspace-global even across independent workstreams", async () => {
  const { service } = makeService();
  const { first, second } = await twoSessions(service);
  const left = await service.createWorkstream({ sessionId: first.sessionId,
    generation: first.generation, title: "Camera", objective: "Ship the camera" });
  const right = await service.createWorkstream({ sessionId: second.sessionId,
    generation: second.generation, title: "Models", objective: "Ship the models" });
  await service.acquireClaim(claiming(first, { workstreamId: left.workstreamId }));

  // Approved 2026-08-15: independent work stays independent, but a claim is a
  // workspace-wide fact. Two workstreams cannot both own one resource.
  await assert.rejects(service.acquireClaim(claiming(second,
    { workstreamId: right.workstreamId })), error => error.code === EXIT.CONFLICT);
});

test("an expired lease stops conflicting", async () => {
  const { service, clock } = makeService();
  const { first, second } = await twoSessions(service);
  await service.acquireClaim(claiming(first, { leaseSeconds: 60 }));
  clock.advance(61_000);

  const taken = await service.acquireClaim(claiming(second, { leaseSeconds: 60 }));

  assert.equal(taken.ownerSessionId, second.sessionId);
});

test("renewal requires the exact owner generation", async () => {
  const { service, clock } = makeService();
  const { first } = await twoSessions(service);
  const claim = await service.acquireClaim(claiming(first, { leaseSeconds: 60 }));
  clock.advance(30_000);

  const renewed = await service.renewClaim({ claimId: claim.claimId,
    sessionId: first.sessionId, generation: first.generation, leaseSeconds: 60 });
  assert.equal(Date.parse(renewed.expiresAt) > Date.parse(claim.expiresAt), true);

  await assert.rejects(service.renewClaim({ claimId: claim.claimId,
    sessionId: first.sessionId, generation: "generation_wrong", leaseSeconds: 60 }),
  error => error.code === EXIT.CONFLICT);
});

test("a stale owner still blocks, and the conflict reports the staleness", async () => {
  const { service, clock } = makeService();
  const { first, second } = await twoSessions(service);
  await service.acquireClaim(claiming(first, { leaseSeconds: 1800 }));
  clock.advance(200_000);

  // Presence staleness alone never releases a claim; it is reported so the
  // requester can decide, and the claim still blocks until expiry or force.
  await assert.rejects(service.acquireClaim(claiming(second)), error =>
    error.code === EXIT.CONFLICT && error.details.ownerPresence === "stale");
});

test("a peer cannot force-release another session's claim", async () => {
  const { service } = makeService();
  const { first, second } = await twoSessions(service);
  const claim = await service.acquireClaim(claiming(first));

  await assert.rejects(service.forceReleaseClaim({ claimId: claim.claimId,
    sessionId: second.sessionId, generation: second.generation, authority: "workstream",
    reason: "I want it" }), error => error.code === EXIT.CONFLICT);
});

test("human or policy authority may force-release and the audit records it", async () => {
  const { service, store } = makeService();
  const { first, second } = await twoSessions(service);
  const claim = await service.acquireClaim(claiming(first));

  await service.forceReleaseClaim({ claimId: claim.claimId, sessionId: second.sessionId,
    generation: second.generation, authority: "human", reason: "operator override" });

  const events = (await store.eventsSince(WORKSPACE, null, 50)).events;
  const audit = events.findLast(event => event.type === "claim.force_released");
  assert.equal(audit.payload.authority, "human");
  assert.equal(audit.payload.reason, "operator override");
  assert.equal(audit.payload.replacedGeneration, claim.generation);
  assert.deepEqual((await store.snapshot(WORKSPACE)).claims, []);
});

test("the owner may release its own claim without special authority", async () => {
  const { service, store } = makeService();
  const { first } = await twoSessions(service);
  const claim = await service.acquireClaim(claiming(first));

  await service.releaseClaim({ claimId: claim.claimId, sessionId: first.sessionId,
    generation: first.generation });

  assert.deepEqual((await store.snapshot(WORKSPACE)).claims, []);
  await assert.rejects(service.releaseClaim({ claimId: claim.claimId,
    sessionId: first.sessionId, generation: first.generation }),
  error => error.code === EXIT.CONFLICT);
});

test("acquiring a claim materialises an ephemeral workspace", async () => {
  const { service, store } = makeService();
  const session = await service.openSession(opening());

  await service.acquireClaim(claiming(session));

  // A claim is a durable object, so it is one of the approved triggers even
  // when the session is still alone.
  assert.notEqual((await store.snapshot(WORKSPACE)).workspace, null);
  assert.equal((await store.snapshot(WORKSPACE)).claims.length, 1);
});

test("re-acquiring the same resource by the same owner renews rather than conflicts", async () => {
  const { service } = makeService();
  const { first } = await twoSessions(service);
  const claim = await service.acquireClaim(claiming(first));

  const again = await service.acquireClaim(claiming(first));

  assert.equal(again.claimId, claim.claimId);
});
