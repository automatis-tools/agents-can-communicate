import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

test("installed opening preserves the owner that acquired the session first", async t => {
  const packed = await createPackedAcc(t);
  const load = name => import(pathToFileURL(path.join(packed.installed, "node_modules",
    "@agents-can-communicate", name, "src", "index.mjs")).href);
  const { createCoordinationService } = await load("core");
  const { openFilesystemStore } = await load("storage-filesystem");
  const { createId } = await load("protocol");
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind) };
  const workspaceId = "workspace_opening";
  const opening = (participantId, sessionId) => ({ workspaceId, participantId, sessionId,
    harness: "fixture", heartbeatCadenceMs: 60_000 });
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  async function fixture(name, mode) {
    const store = await openFilesystemStore({ root: path.join(packed.root, name),
      workspaceId, clock, ids });
    const service = createCoordinationService({ store, clock, ids });
    if (mode !== "ephemeral") await service.openSession(opening("peer1"));
    if (mode === "durable") await service.openSession(opening("peer2"));
    const inspect = async () => ({ durable: await store.snapshot(workspaceId),
      sessions: await store.ephemeral.list("session"),
      events: await store.eventsSince(workspaceId, null, 100) });
    return { store, service, inspect };
  }

  for (const mode of ["ephemeral", "durable", "promotion"]) {
    for (const previous of mode === "promotion" ? ["absent"] : ["absent", "replaceable"]) {
      await t.test(`${mode} ${previous} id rejects an opener overtaken before its write`, async () => {
        const { store, service, inspect } = await fixture(`${mode}-${previous}`, mode);
        const sessionId = "session_shared";
        if (previous === "replaceable") {
          const old = await service.openSession({ ...opening("writer", sessionId), pid: 42 });
          // A real close authorizes replacement; silence alone never does.
          await service.closeSession(owner(old));
        }
        let armed = true, winner, checkpoint;
        const intervene = async () => {
          if (!armed) return;
          armed = false;
          winner = await service.openSession(opening("writer", sessionId));
          checkpoint = await inspect();
        };
        const racingStore = { ...store, ephemeral: { ...store.ephemeral },
          transaction: async (callback, options) => {
            if (mode === "durable") await intervene();
            return store.transaction(callback, options);
          } };
        for (const method of ["put", "update"]) {
          racingStore.ephemeral[method] = async (kind, ...args) => {
            if (mode !== "durable" && kind === "session") await intervene();
            return store.ephemeral[method](kind, ...args);
          };
        }
        const racing = createCoordinationService({ store: racingStore, clock, ids });
        await assert.rejects(racing.openSession(opening("writer", sessionId)), error => error.code === 5);
        assert.equal(armed, false, "the competing open did not run");
        assert.deepEqual(await inspect(), checkpoint, "rejected open changed session state or events");
        assert.equal((await service.heartbeatSession(owner(winner))).generation, winner.generation);
        await service.closeSession(owner(winner));
        const successor = await service.openSession(opening("writer", sessionId));
        assert.notEqual(successor.generation, winner.generation);
        assert.equal((await service.heartbeatSession(owner(successor))).generation, successor.generation);
      });
    }
  }

  for (const mode of ["ephemeral", "durable"]) {
    await t.test(`${mode} open rejects a different workspace before writing`, async () => {
      const { store, service, inspect } = await fixture(`${mode}-scope`, mode);
      const before = await inspect();
      const participants = await store.ephemeral.list("participant");
      await assert.rejects(service.openSession({ ...opening("wrong"),
        workspaceId: "workspace_wrong" }), error => error.code === 5);
      assert.deepEqual(await inspect(), before);
      assert.deepEqual(await store.ephemeral.list("participant"), participants);
    });

    await t.test(`${mode} open preserves existing participant metadata`, async () => {
      const { store, service } = await fixture(`${mode}-participant`, mode);
      await service.openSession({ ...opening("writer"), displayName: "Original name" });
      const before = (await store.snapshot(workspaceId)).participants.find(p => p.participantId === "writer")
        ?? await store.ephemeral.get("participant", "writer");
      await service.openSession({ ...opening("writer"), displayName: "Replacement name" });
      const participant = (await store.snapshot(workspaceId)).participants.find(p => p.participantId === "writer");
      assert.deepEqual(participant, before);
    });

    await t.test(`${mode} open rechecks whether a previously dead owner resumed`, async () => {
      const { store } = await fixture(`${mode}-revived`, mode);
      const service = createCoordinationService({ store, clock, ids,
        pidIsAlive: pid => pid === process.pid });
      const original = await service.openSession({ ...opening("writer", "session_revived"), pid: 42 });
      let armed = true;
      const intervene = async () => {
        if (!armed) return;
        armed = false;
        await service.resumeSession({ ...owner(original), pid: process.pid });
      };
      const racingStore = { ...store, ephemeral: { ...store.ephemeral },
        transaction: async (callback, options) => {
          if (mode === "durable") await intervene();
          return store.transaction(callback, options);
        } };
      for (const method of ["put", "update"]) {
        racingStore.ephemeral[method] = async (kind, ...args) => {
          if (mode === "ephemeral" && kind === "session") await intervene();
          return store.ephemeral[method](kind, ...args);
        };
      }
      const racing = createCoordinationService({ store: racingStore, clock, ids,
        pidIsAlive: pid => pid === process.pid });
      await assert.rejects(racing.openSession(opening("writer", original.sessionId)), error => error.code === 5);
      assert.equal(armed, false);
      assert.equal((await service.heartbeatSession(owner(original))).pid, process.pid);
    });
  }

  for (const boundary of ["participant", "session"]) {
    await t.test(`distinct attach survives promotion before its ${boundary} write`, async () => {
      const { store, service } = await fixture(`distinct-${boundary}`, "promotion");
      let armed = true;
      const racingStore = { ...store, ephemeral: { ...store.ephemeral } };
      for (const method of ["put", "update"]) {
        racingStore.ephemeral[method] = async (kind, ...args) => {
          if (armed && kind === boundary) {
            armed = false;
            await service.openSession(opening("peer2"));
          }
          return store.ephemeral[method](kind, ...args);
        };
      }
      const racing = createCoordinationService({ store: racingStore, clock, ids });
      const joined = await racing.openSession(opening("late", "session_late"));
      assert.equal(armed, false);
      assert.equal((await service.heartbeatSession(owner(joined))).generation, joined.generation);
      const snapshot = await store.snapshot(workspaceId);
      assert.equal(snapshot.sessions.length, 3);
      assert.deepEqual(snapshot.participants.map(p => p.participantId).sort(), ["late", "peer1", "peer2"]);
      assert.deepEqual(await store.ephemeral.list("session"), []);
      assert.deepEqual(await store.ephemeral.list("participant"), []);
    });
  }
});
