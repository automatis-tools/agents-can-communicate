import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

test("installed lifecycle writes cannot overwrite a later session state", async t => {
  const packed = await createPackedAcc(t);
  const load = name => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", "index.mjs")).href);
  const { createCoordinationService } = await load("core");
  const { openFilesystemStore } = await load("storage-filesystem");
  const { createId } = await load("protocol");
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind) };
  const workspaceId = "workspace_session_race";
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  const opening = participantId => ({ participantId, workspaceId,
    harness: "fixture", heartbeatCadenceMs: 60_000 });

  async function fixture(name, mode) {
    const store = await openFilesystemStore({ root: path.join(packed.root, name),
      workspaceId, clock, ids });
    const service = createCoordinationService({ store, clock, ids });
    const original = await service.openSession(opening("reader"));
    if (mode === "durable") await service.openSession(opening("peer"));
    const inspect = async () => ({ durable: await store.snapshot(workspaceId),
      ephemeral: await store.ephemeral.list("session"),
      intents: await store.ephemeral.list("intent"),
      events: await store.eventsSince(workspaceId, null, 100) });
    return { store, service, original, inspect };
  }

  for (const mode of ["ephemeral", "durable"]) {
    for (const operation of ["heartbeatSession", "closeSession"]) {
      await t.test(`${mode} ${operation} rejects another workspace`, async () => {
        const { service, original, inspect } = await fixture(`${mode}-${operation}-scope`, mode);
        const before = await inspect();
        await assert.rejects(service[operation]({ ...owner(original),
          workspaceId: "workspace_wrong" }), error => error.code === 5);
        assert.deepEqual(await inspect(), before);
      });
      for (const transition of ["replace", "resume", ...operation === "heartbeatSession"
        ? ["close"] : []]) {
        await t.test(`${mode} ${operation} respects a concurrent ${transition}`, async () => {
          const { store, service, original, inspect } = await fixture(
            `${mode}-${operation}-${transition}`, mode);
          let armed = true, checkpoint, changed;
          const intervene = async () => {
            if (!armed) return;
            armed = false;
            if (transition === "resume") {
              changed = await service.resumeSession({ ...owner(original), pid: process.pid });
            } else {
              await service.closeSession(owner(original));
              if (transition === "replace") changed = await service.openSession({
                ...opening("reader"), sessionId: original.sessionId });
            }
            checkpoint = await inspect();
          };
          const ephemeral = { ...store.ephemeral,
            get: async (kind, id) => {
              const current = await store.ephemeral.get(kind, id);
              if (mode === "ephemeral" && kind === "session") await intervene();
              return current;
            },
            update: async (kind, id, updater) => {
              if (mode === "ephemeral" && kind === "session") await intervene();
              return store.ephemeral.update(kind, id, updater);
            },
            delete: async (kind, id, guard) => {
              if (mode === "ephemeral" && kind === "session") await intervene();
              return store.ephemeral.delete(kind, id, guard);
            },
          };
          const racingStore = { ...store, ephemeral,
            transaction: async (callback, options) => {
              if (mode === "durable") await intervene();
              return store.transaction(callback, options);
            } };
          const racing = createCoordinationService({ store: racingStore, clock, ids });
          if (transition === "resume") {
            const result = await racing[operation](owner(original));
            assert.equal(result.pid, process.pid, "a stale record overwrote current metadata");
            assert.equal(result.generation, original.generation);
            const state = await inspect();
            const current = mode === "ephemeral" ? state.ephemeral[0]
              : state.durable.sessions.find(s => s.sessionId === original.sessionId);
            if (mode === "ephemeral" && operation === "closeSession") {
              assert.equal(current, undefined);
            } else {
              assert.equal(current.pid, process.pid);
              assert.equal(current.state, operation === "closeSession" ? "closed" : "open");
            }
          } else {
            await assert.rejects(racing[operation](owner(original)), error => error.code === 5);
            assert.deepEqual(await inspect(), checkpoint);
            if (transition === "replace") {
              assert.notEqual(changed.generation, original.generation);
              const beat = await service.heartbeatSession(owner(changed));
              assert.equal(beat.generation, changed.generation);
            }
          }
          assert.equal(armed, false, "the concurrent operation never ran");
        });
      }
    }
  }

  await t.test("solo close cleanup preserves a successor's intent", async () => {
    const { store, service, original } = await fixture("intent-cleanup", "ephemeral");
    await service.setIntent({ ...owner(original), summary: "old work", mode: "review" });
    let successor;
    const racingStore = { ...store, ephemeral: { ...store.ephemeral,
      delete: async (kind, id, guard) => {
        if (kind === "intent" && successor === undefined) {
          successor = await service.openSession({ ...opening("reader"),
            sessionId: original.sessionId });
          await service.setIntent({ ...owner(successor), summary: "new work", mode: "review" });
        }
        return store.ephemeral.delete(kind, id, guard);
      },
    } };
    const racing = createCoordinationService({ store: racingStore, clock, ids });
    await racing.closeSession(owner(original));
    assert.equal((await store.ephemeral.get("session", original.sessionId)).generation,
      successor.generation);
    assert.equal((await store.ephemeral.get("intent", original.sessionId))?.summary, "new work");
  });
});
