import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const workspaceId = "workspace_batch";
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

async function fixture(withPeer = true) {
  const clock = createFakeClock("2026-10-11T12:00:00.000Z");
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId });
  const service = createCoordinationService({ store, clock, ids: createFakeIds() });
  const open = participantId => service.openSession({ workspaceId, participantId,
    harness: "fixture", heartbeatCadenceMs: 30_000 });
  const alice = await open("alice"), bob = withPeer ? await open("bob") : null;
  const acquire = (session, resource, extra = {}) => service.acquireClaim({
    ...owner(session), resource, reason: "fixture", ...extra });
  const inspect = async () => ({ snapshot: await store.snapshot(workspaceId),
    events: await store.eventsSince(workspaceId, null, 100) });
  return { clock, store, service, alice, bob, acquire, inspect };
}

test("batch acquisition records every requested resource in order", async () => {
  const { service, alice, inspect } = await fixture();
  const claims = await service.acquireClaims({ ...owner(alice),
    resources: ["file:a.mjs", "file:b.mjs"], reason: "batch" });
  assert.deepEqual(claims.map(c => c.resource), ["file:a.mjs", "file:b.mjs"]);
  assert.deepEqual(claims.map(c => c.mode), ["exclusive", "exclusive"]);
  const state = await inspect();
  assert.equal(state.snapshot.claims.length, 2);
  assert.deepEqual(state.events.events.filter(e => e.type === "claim.acquired")
    .map(e => e.payload.resource), ["file:a.mjs", "file:b.mjs"]);
});

test("a batch conflict changes no earlier claim or renewal and names all blockers", async () => {
  const f = await fixture();
  await f.acquire(f.alice, "file:a.mjs");
  const b = await f.acquire(f.bob, "file:b/**");
  const c = await f.acquire(f.bob, "file:c.mjs");
  f.clock.advance(1000);
  const before = await f.inspect();
  await assert.rejects(f.service.acquireClaims({ ...owner(f.alice),
    resources: ["file:a.mjs", "file:b/x.mjs", "file:c.mjs", "file:d.mjs"],
    reason: "batch" }), error => {
    assert.equal(error.code, EXIT.CONFLICT);
    assert.deepEqual(error.details.conflicts.map(item => item.requestedResource),
      ["file:b/x.mjs", "file:c.mjs"]);
    assert.deepEqual(error.details.conflicts.map(item => item.claimId), [b.claimId, c.claimId]);
    assert.equal(error.details.conflicts.every(item => item.ownerSessionId === f.bob.sessionId), true);
    return true;
  });
  assert.deepEqual(await f.inspect(), before);
});

test("a late conflict leaves no newly acquired prefix or journal events", async () => {
  const f = await fixture();
  await f.acquire(f.bob, "file:b.mjs");
  const before = await f.inspect();
  await assert.rejects(f.service.acquireClaims({ ...owner(f.alice),
    resources: ["file:a.mjs", "file:b.mjs"], reason: "atomic batch" }),
  error => error.code === EXIT.CONFLICT);
  assert.deepEqual(await f.inspect(), before);
});

test("default exclusive batches conflict with another owner's shared claim", async () => {
  const f = await fixture();
  await f.acquire(f.bob, "file:b.mjs", { mode: "shared" });
  const before = await f.inspect();
  await assert.rejects(f.service.acquireClaims({ ...owner(f.alice),
    resources: ["file:a.mjs", "file:b.mjs"], reason: "exclusive by default" }),
  error => error.code === EXIT.CONFLICT);
  assert.deepEqual(await f.inspect(), before);
  const shared = await f.service.acquireClaims({ ...owner(f.alice),
    resources: ["file:a.mjs", "file:b.mjs"], mode: "shared", reason: "shared batch" });
  assert.deepEqual(shared.map(c => c.mode), ["shared", "shared"]);
});

test("invalid and canonical duplicate resources do not change claims or events", async () => {
  const f = await fixture();
  await f.acquire(f.alice, "file:held.mjs");
  const before = await f.inspect();
  for (const resources of [[], null, "file:a.mjs", ["file:a.mjs", 7],
    ["file:a.mjs", "file:src/*"], ["file:a.mjs", "file:./a.mjs"]]) {
    await assert.rejects(f.service.acquireClaims({ ...owner(f.alice), resources, reason: "invalid" }),
      error => error.code === EXIT.USAGE);
    assert.deepEqual(await f.inspect(), before);
  }
});

test("explicit releases validate missing and foreign claims before removing owned claims", async () => {
  const f = await fixture();
  const a = await f.acquire(f.alice, "file:a.mjs");
  const b = await f.acquire(f.bob, "file:b.mjs");
  const before = await f.inspect();
  for (const selectors of [{ claimIds: [a.claimId, b.claimId] },
    { claimIds: [a.claimId, "claim_missing"] }, { resources: ["file:a.mjs", "file:b.mjs"] }]) {
    await assert.rejects(f.service.releaseClaims({ ...owner(f.alice), ...selectors }),
      error => [EXIT.CONFLICT, EXIT.DATA].includes(error.code));
    assert.deepEqual(await f.inspect(), before);
  }
  const c = await f.acquire(f.alice, "file:c.mjs");
  const released = await f.service.releaseClaims({ ...owner(f.alice),
    resources: ["file:a.mjs", "file:c.mjs"] });
  assert.deepEqual(released.map(claim => claim.claimId), [a.claimId, c.claimId]);
  assert.deepEqual((await f.inspect()).snapshot.claims.map(claim => claim.claimId), [b.claimId]);
});

test("release all keeps intent and session open and leaves other owners alone", async () => {
  const f = await fixture();
  await f.service.setIntent({ ...owner(f.alice), summary: "still working", mode: "edit" });
  const a = await f.acquire(f.alice, "file:a.mjs");
  const b = await f.acquire(f.bob, "file:b.mjs");
  const before = await f.inspect();
  const released = await f.service.releaseClaims({ ...owner(f.alice), all: true });
  assert.deepEqual(released.map(claim => claim.claimId), [a.claimId]);
  const after = await f.inspect();
  assert.deepEqual(after.snapshot.sessions, before.snapshot.sessions);
  assert.deepEqual(after.snapshot.intents, before.snapshot.intents);
  assert.deepEqual(after.snapshot.claims.map(claim => claim.claimId), [b.claimId]);
  assert.deepEqual(await f.service.releaseClaims({ ...owner(f.alice), all: true }), []);
  assert.deepEqual(await f.inspect(), after);
});

test("empty release all succeeds in a solo ephemeral workspace without materialising it", async () => {
  const f = await fixture(false);
  const before = await f.inspect();
  assert.equal(before.snapshot.workspace, null);
  assert.deepEqual(await f.service.releaseClaims({ ...owner(f.alice), all: true }), []);
  assert.deepEqual(await f.inspect(), before);
});

test("release selectors reject empty, mixed and duplicate lists without changing state", async () => {
  const f = await fixture();
  const a = await f.acquire(f.alice, "file:a.mjs");
  const before = await f.inspect();
  for (const selectors of [{}, { all: false }, { claimIds: [] }, { resources: [] },
    { claimIds: [a.claimId, a.claimId] }, { resources: ["file:a.mjs", "file:./a.mjs"] },
    { claimIds: [a.claimId], resources: ["file:a.mjs"] },
    { all: true, claimIds: [a.claimId] }]) {
    await assert.rejects(f.service.releaseClaims({ ...owner(f.alice), ...selectors }),
      error => error.code === EXIT.USAGE);
    assert.deepEqual(await f.inspect(), before);
  }
});

test("batch writes recheck the owning generation under the writer mutex", async () => {
  for (const operation of ["acquireClaims", "releaseClaims"]) {
    const f = await fixture();
    await f.acquire(f.alice, "file:a.mjs");
    let checkpoint, armed = true;
    const racingStore = { ...f.store, transaction: async (callback, options) => {
      if (armed) {
        armed = false;
        await f.service.closeSession(owner(f.alice));
        await f.service.openSession({ workspaceId, participantId: "alice",
          sessionId: f.alice.sessionId, harness: "fixture", heartbeatCadenceMs: 30_000 });
        checkpoint = await f.inspect();
      }
      return f.store.transaction(callback, options);
    } };
    const racing = createCoordinationService({ store: racingStore, clock: f.clock, ids: createFakeIds() });
    await assert.rejects(racing[operation]({ ...owner(f.alice),
      ...(operation === "acquireClaims" ? { resources: ["file:a.mjs", "file:b.mjs"], reason: "late" }
        : { all: true }) }), error => error.code === EXIT.CONFLICT);
    assert.equal(armed, false);
    assert.deepEqual(await f.inspect(), checkpoint);
  }
});
