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

// The refusal is read by a model, which acted on a bare "the resource is
// already claimed" by reading the details itself (#146).
test("a refusal names the holder, the lease end and one next action in one sentence", async () => {
  const { service } = makeService();
  const { first, second } = await twoSessions(service);
  const held = await service.acquireClaim(claiming(first, { resource: "file:packages/core/**" }));

  const refused = await service.acquireClaim(claiming(second)).catch(error => error);

  assert.equal(refused.code, EXIT.CONFLICT);
  assert.equal(refused.message, `${RESOURCE} is claimed by participant_a (session ${first.sessionId}) as file:packages/core/** `
    + `until ${held.expiresAt}; ask participant_a to release it, claim a `
    + "narrower resource, or retry after it expires.");
  assert.equal(refused.details.ownerParticipantId, "participant_a");
  assert.equal(refused.details.claimId, held.claimId);
});

test("a refusal by an offline holder points to the user's release, not to the holder", async () => {
  const { service, clock } = makeService();
  const { first, second } = await twoSessions(service);
  const held = await service.acquireClaim(claiming(first, { leaseSeconds: 7200 }));
  clock.advance(31 * 60_000); // Past the floor for a session that records no process.

  const refused = await service.acquireClaim(claiming(second)).catch(error => error);

  assert.equal(refused.details.ownerPresence, "offline");
  assert.equal(refused.message, `${RESOURCE} is claimed by participant_a (session ${first.sessionId}) until ${held.expiresAt}; `
    + "its session is offline, so ask your user whether to release it with acc release --claim "
    + `${held.claimId} --authority human --reason "<their decision>", or retry after it expires.`);
});

test("claims hold any scheme, and overlap is decided the same way for each", async () => {
  // Exact names conflict, and a `/**` glob covers what lies under it segment by
  // segment - for a port or a shared tool as for a file.
  assert.equal(overlaps("port:7319", "port:7319"), true);
  assert.equal(overlaps("port:7319", "port:7320"), false);
  assert.equal(overlaps("tool:browser/**", "tool:browser/main-profile"), true);
  assert.equal(overlaps("tool:browser/**", "tool:browserstack"), false);
  const { service } = makeService();
  const { first, second } = await twoSessions(service);
  await service.acquireClaim(claiming(first, { resource: "port:7319" }));

  await assert.rejects(service.acquireClaim(claiming(second, { resource: "port:7319" })),
    /port:7319 is claimed by participant_a \(session session_\S+\) until /);
  const other = await service.acquireClaim(claiming(second, { resource: "port:7320" }));
  assert.equal(other.resource, "port:7320");
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

test("a lapsed claim cannot be renewed once another session holds the resource", async () => {
  const { service, clock } = makeService();
  const { first, second } = await twoSessions(service);
  const lapsed = await service.acquireClaim(claiming(first, { leaseSeconds: 1 }));
  clock.advance(2_000);
  const taken = await service.acquireClaim(claiming(second));

  await assert.rejects(service.renewClaim({ claimId: lapsed.claimId,
    sessionId: first.sessionId, generation: first.generation, leaseSeconds: 600 }),
  error => error.code === EXIT.CONFLICT
    && error.message === `claim ${lapsed.claimId} has lapsed; acquire the resource again`
    && error.details.resource === RESOURCE && error.details.expiresAt === lapsed.expiresAt);

  const live = (await service.collectStatus({ workspaceId: WORKSPACE })).claims
    .filter(claim => claim.resource === RESOURCE
      && Date.parse(claim.expiresAt) > Date.parse(clock.now()));
  assert.deepEqual(live.map(claim => claim.claimId), [taken.claimId]);
});

test("a claim is refused renewal at its exact expiry and taken back by acquiring it", async () => {
  const { service, clock } = makeService();
  const { first } = await twoSessions(service);
  const claim = await service.acquireClaim(claiming(first, { leaseSeconds: 1 }));
  clock.advance(1_000);

  await assert.rejects(service.renewClaim({ claimId: claim.claimId,
    sessionId: first.sessionId, generation: first.generation, leaseSeconds: 600 }),
  error => error.code === EXIT.CONFLICT);

  const again = await service.acquireClaim(claiming(first));
  assert.equal(again.claimId, claim.claimId);
  assert.equal(again.expiresAt, "2026-08-16T01:30:01.000Z");
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
