import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// The wrapper schedules a real lifecycle change before the installed store
// takes its writer lock; it does not replace records or transaction behavior.
test("installed claim writes reject owners closed or replaced before commit", async t => {
  const packed = await createPackedAcc(t);
  const load = name => import(pathToFileURL(path.join(packed.installed, "node_modules",
    "@agents-can-communicate", name, "src", "index.mjs")).href);
  const { createCoordinationService } = await load("core");
  const { openFilesystemStore } = await load("storage-filesystem");
  const { createId } = await load("protocol");
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind) };
  const workspaceId = "workspace_claim_generation";
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  const opening = participantId => ({ participantId, workspaceId, harness: "fixture",
    heartbeatCadenceMs: 60_000 });

  await t.test("first solo claim rejects a different explicit workspace", async () => {
    const store = await openFilesystemStore({ root: path.join(packed.root, "wrong-workspace"),
      workspaceId, clock, ids });
    const service = createCoordinationService({ store, clock, ids });
    const session = await service.openSession(opening("solo"));
    await assert.rejects(service.acquireClaim({ ...owner(session), workspaceId: "workspace_wrong",
      resource: "file:src/a.mjs", reason: "wrong workspace" }), error => error.code === 5);
    assert.equal((await store.snapshot(workspaceId)).workspace, null);
    assert.deepEqual((await store.eventsSince(workspaceId, null, 100)).events, []);
  });

  for (const operation of ["acquireClaim", "renewClaim", "releaseClaim", "forceReleaseClaim"]) {
    for (const transition of ["close", "replace"]) {
      await t.test(`${operation} refuses a concurrent ${transition}`, async () => {
        const store = await openFilesystemStore({ root: path.join(packed.root,
          `${operation}-${transition}`), workspaceId, clock, ids });
        const service = createCoordinationService({ store, clock, ids });
        const original = await service.openSession(opening("writer"));
        const peer = await service.openSession(opening("peer"));
        const claimInput = { resource: "file:src/a.mjs", mode: "exclusive",
          reason: "original work", leaseSeconds: 600 };
        const claim = await service.acquireClaim({ ...owner(operation === "forceReleaseClaim"
          ? peer : original), ...claimInput });
        const inspect = async () => ({ snapshot: await store.snapshot(workspaceId),
          events: await store.eventsSince(workspaceId, null, 100) });
        let armed = true, checkpoint, successor;
        const racingStore = { ...store, transaction: async (callback, options) => {
          if (armed) {
            armed = false;
            await service.closeSession(owner(original));
            if (transition === "replace") {
              successor = await service.openSession({ ...opening("writer"),
                sessionId: original.sessionId });
              if (operation !== "forceReleaseClaim") {
                await service.acquireClaim({ ...owner(successor), ...claimInput,
                  reason: "successor work" });
              }
            }
            checkpoint = await inspect();
          }
          return store.transaction(callback, options);
        } };
        const racing = createCoordinationService({ store: racingStore, clock, ids });
        const input = { ...owner(original), ...claimInput, claimId: claim.claimId,
          authority: "human", reason: "late operation" };
        await assert.rejects(racing[operation](input), error => error.code === 5);
        assert.equal(armed, false, "the lifecycle change did not run");
        assert.deepEqual(await inspect(), checkpoint, "a stale owner changed claims or events");
        successor ??= await service.openSession({ ...opening("writer"),
          sessionId: original.sessionId });
        assert.notEqual(successor.generation, original.generation);
        if (operation === "forceReleaseClaim") {
          await service.forceReleaseClaim({ ...input, ...owner(successor) });
          assert.deepEqual((await inspect()).snapshot.claims, []);
        } else {
          const renewed = await service.renewClaim({ ...owner(successor), claimId: claim.claimId });
          assert.equal(renewed.ownerSessionId, successor.sessionId);
        }
      });
    }
  }

  for (const transition of ["close", "replace"]) {
    await t.test(`first solo claim refuses a concurrent ${transition} during promotion`, async () => {
      const store = await openFilesystemStore({ root: path.join(packed.root,
        `solo-${transition}`), workspaceId, clock, ids });
      const service = createCoordinationService({ store, clock, ids });
      const original = await service.openSession(opening("solo"));
      let armed = true, successor;
      const racingStore = { ...store, transaction: async (callback, options) => {
        if (armed) {
          armed = false;
          await service.closeSession(owner(original));
          if (transition === "replace") successor = await service.openSession({
            ...opening("solo"), sessionId: original.sessionId });
        }
        return store.transaction(callback, options);
      } };
      const racing = createCoordinationService({ store: racingStore, clock, ids });
      await assert.rejects(racing.acquireClaim({ ...owner(original), resource: "file:src/a.mjs",
        reason: "stale first claim" }), error => error.code === 5);
      assert.equal(armed, false);
      const snapshot = await store.snapshot(workspaceId);
      assert.deepEqual(snapshot.claims, []);
      const current = await service.locateSession(original.sessionId);
      if (successor === undefined) assert.equal(current, null);
      else assert.equal(current.record.generation, successor.generation);
      assert.equal((await store.eventsSince(workspaceId, null, 100)).events
        .some(event => event.type === "claim.acquired"), false);
    });
  }
});
