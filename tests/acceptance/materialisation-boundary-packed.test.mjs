import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

test("installed promotion preserves writes at both sides of its transaction", async t => {
  const packed = await createPackedAcc(t);
  const load = name => import(pathToFileURL(path.join(packed.installed, "node_modules",
    "@agents-can-communicate", name, "src", "index.mjs")).href);
  const { createCoordinationService } = await load("core");
  const { openFilesystemStore } = await load("storage-filesystem");
  const { createId } = await load("protocol");
  const workspaceId = "workspace_promotion_boundary";
  const opening = participantId => ({ participantId, workspaceId, harness: "fixture",
    heartbeatCadenceMs: 60_000 });
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  async function fixture(name) {
    let now = "2026-09-07T12:00:00.000Z";
    const clock = { now: () => now }, ids = { next: kind => createId(kind) };
    const store = await openFilesystemStore({ root: path.join(packed.root, name),
      workspaceId, clock, ids });
    const service = createCoordinationService({ store, clock, ids });
    const session = await service.openSession(opening("writer"));
    await service.setIntent({ ...owner(session), summary: "old work", mode: "edit" });
    return { store, service, session, clock, ids,
      advance: () => { now = "2026-09-07T12:00:30.000Z"; } };
  }
  const intentArgs = session => ({ ...owner(session), summary: "latest work", mode: "review" });

  for (const operation of ["setIntent", "clearIntent"]) {
    for (const boundary of ["before promotion commit", "before ephemeral write",
      ...operation === "clearIntent" ? ["before ephemeral write with copies pending"] : []]) {
      await t.test(`${operation} survives promotion ${boundary}`, async () => {
        const f = await fixture(`${operation}-${boundary.replaceAll(" ", "-")}`);
        let armed = true;
        const racingStore = { ...f.store, ephemeral: { ...f.store.ephemeral } };
        if (boundary === "before promotion commit") {
          racingStore.transaction = async (callback, options) => {
            if (armed) { armed = false; await f.service[operation](intentArgs(f.session)); }
            return f.store.transaction(callback, options);
          };
        } else {
          for (const method of ["put", "update", "delete"]) {
            racingStore.ephemeral[method] = async (kind, ...args) => {
              if (armed && kind === "intent") {
                armed = false;
                if (boundary.endsWith("copies pending")) {
                  let result;
                  const promoting = createCoordinationService({ ...f, store: {
                    ...f.store, transaction: async (callback, options) => {
                      const promoted = await f.store.transaction(callback, options);
                      result = await f.store.ephemeral[method](kind, ...args);
                      return promoted;
                    } } });
                  await promoting.openSession(opening("peer"));
                  return result;
                }
                await f.service.openSession(opening("peer"));
              }
              return f.store.ephemeral[method](kind, ...args);
            };
          }
        }
        const racing = createCoordinationService({ ...f, store: racingStore });
        if (boundary === "before promotion commit") await racing.openSession(opening("peer"));
        else await racing[operation](intentArgs(f.session));
        assert.equal(armed, false);
        const snapshot = await f.store.snapshot(workspaceId);
        if (operation === "setIntent") assert.equal(snapshot.intents[0].summary, "latest work");
        else assert.equal(snapshot.intents.some(intent => intent.state === "active"), false);
        assert.deepEqual(await f.store.ephemeral.list("intent"), []);
      });
    }
  }

  for (const operation of ["heartbeatSession", "resumeSession", "closeSession", "replaceSession"]) {
    await t.test(`${operation} survives the interval before promoted copies retire`, async () => {
      const f = await fixture(operation);
      let armed = true;
      const racingStore = { ...f.store, transaction: async (callback, options) => {
        const result = await f.store.transaction(callback, options);
        if (armed) {
          armed = false;
          f.advance();
          if (operation === "replaceSession") {
            await f.service.closeSession(owner(f.session));
            await f.service.openSession({ ...opening("writer"), sessionId: f.session.sessionId });
          } else await f.service[operation]({ ...owner(f.session), pid: process.pid });
        }
        return result;
      } };
      const racing = createCoordinationService({ ...f, store: racingStore });
      await racing.openSession(opening("peer"));
      assert.equal(armed, false);
      const current = (await f.store.snapshot(workspaceId)).sessions
        .find(session => session.sessionId === f.session.sessionId);
      assert.equal(current.heartbeatAt, f.clock.now());
      assert.equal(current.state, operation === "closeSession" ? "closed" : "open");
      if (operation === "resumeSession") assert.equal(current.pid, process.pid);
      if (operation === "replaceSession") assert.notEqual(current.generation, f.session.generation);
      assert.deepEqual(await f.store.ephemeral.list("session"), []);
    });
  }
});
