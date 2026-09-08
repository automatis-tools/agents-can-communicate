import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

test("installed intent writes cannot change a closed or replacement owner's work", async t => {
  const packed = await createPackedAcc(t);
  const load = name => import(pathToFileURL(path.join(packed.installed, "node_modules",
    "@agents-can-communicate", name, "src", "index.mjs")).href);
  const { createCoordinationService } = await load("core");
  const { openFilesystemStore } = await load("storage-filesystem");
  const { createId } = await load("protocol");
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind) };
  const workspaceId = "workspace_intent_generation";
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  const opening = participantId => ({ participantId, workspaceId, harness: "fixture",
    heartbeatCadenceMs: 60_000 });

  for (const operation of ["setIntent", "clearIntent"]) {
    await t.test(`solo ${operation} rejects a different explicit workspace`, async () => {
      const store = await openFilesystemStore({ root: path.join(packed.root, `scope-${operation}`),
        workspaceId, clock, ids });
      const service = createCoordinationService({ store, clock, ids });
      const session = await service.openSession(opening("solo"));
      await service.setIntent({ ...owner(session), summary: "my work", mode: "edit" });
      const before = await store.ephemeral.list("intent");
      await assert.rejects(service[operation]({ ...owner(session), workspaceId: "workspace_wrong",
        summary: "wrong workspace", mode: "edit" }), error => error.code === 5);
      assert.deepEqual(await store.ephemeral.list("intent"), before);
      assert.equal((await store.snapshot(workspaceId)).workspace, null);
    });
  }

  for (const mode of ["ephemeral", "durable"]) {
    for (const operation of ["setIntent", "clearIntent"]) {
      for (const transition of ["close", "replace"]) {
        await t.test(`${mode} ${operation} respects a concurrent ${transition}`, async () => {
          const store = await openFilesystemStore({ root: path.join(packed.root,
            `${mode}-${operation}-${transition}`), workspaceId, clock, ids });
          const service = createCoordinationService({ store, clock, ids });
          const original = await service.openSession(opening("writer"));
          if (mode === "durable") await service.openSession(opening("peer"));
          await service.setIntent({ ...owner(original), summary: "original work", mode: "edit" });
          const inspect = async () => ({ snapshot: await store.snapshot(workspaceId),
            ephemeral: await store.ephemeral.list("intent"),
            events: await store.eventsSince(workspaceId, null, 100) });
          let armed = true, checkpoint, successor;
          const intervene = async () => {
            if (!armed) return;
            armed = false;
            await service.closeSession(owner(original));
            if (transition === "replace") {
              successor = await service.openSession({ ...opening("writer"),
                sessionId: original.sessionId });
              await service.setIntent({ ...owner(successor), summary: "successor work", mode: "review" });
            }
            checkpoint = await inspect();
          };
          const racingStore = { ...store,
            transaction: async (callback, options) => {
              if (mode === "durable") await intervene();
              return store.transaction(callback, options);
            },
            ephemeral: { ...store.ephemeral } };
          for (const method of ["put", "update", "delete"]) {
            racingStore.ephemeral[method] = async (kind, ...args) => {
              if (mode === "ephemeral" && kind === "intent") await intervene();
              return store.ephemeral[method](kind, ...args);
            };
          }
          const racing = createCoordinationService({ store: racingStore, clock, ids });
          await assert.rejects(racing[operation]({ ...owner(original),
            summary: "late write", mode: "edit" }), error => error.code === 5);
          assert.equal(armed, false);
          assert.deepEqual(await inspect(), checkpoint, "the stale intent operation changed state");
          successor ??= await service.openSession({ ...opening("writer"), sessionId: original.sessionId });
          await service.setIntent({ ...owner(successor), summary: "current work", mode: "edit" });
          await service.clearIntent(owner(successor));
          const after = await inspect();
          if (mode === "ephemeral") {
            assert.deepEqual(after.ephemeral, []);
            assert.equal(after.snapshot.workspace, null);
          } else assert.equal(after.snapshot.intents[0].state, "done");
        });
      }
    }
  }
});
