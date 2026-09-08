import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { openFilesystemStore } from "../src/store.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

for (const storage of ["memory", "filesystem"]) {
  test(`${storage} conditional ephemeral deletion checks the record under the writer lock`, async t => {
    const clock = createFakeClock("2026-09-07T10:00:00.000Z");
    const ids = createFakeIds();
    const root = await mkdtemp(path.join(os.tmpdir(), "acc-delete-guard-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = storage === "memory" ? createMemoryStore({ clock, ids })
      : await openFilesystemStore({ root, clock, ids, workspaceId: "workspace_a" });
    const original = { schemaVersion: SCHEMA_VERSION, sessionId: "session_reader",
      participantId: "reader", workspaceId: "workspace_a", generation: "generation_old",
      harness: "fixture", state: "open", parentSessionId: null,
      checkoutRoot: null, branch: null, pid: null, enforcement: "advisory", lifecycle: "manual",
      heartbeatCadenceMs: 60_000, startedAt: clock.now(), heartbeatAt: clock.now() };
    await store.ephemeral.put("session", original.sessionId, original);
    let entered, release;
    const inside = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const replacement = store.ephemeral.update("session", original.sessionId, async current => {
      entered();
      await gate;
      return { ...current, generation: "generation_new" };
    });
    await inside;
    const deletion = store.ephemeral.delete("session", original.sessionId,
      current => current.generation === original.generation);
    await new Promise(resolve => setImmediate(resolve));
    release();
    await Promise.all([replacement, deletion]);
    assert.equal((await store.ephemeral.get("session", original.sessionId))?.generation,
      "generation_new");
    await store.ephemeral.delete("session", original.sessionId,
      current => current.generation === "generation_new");
    assert.equal(await store.ephemeral.get("session", original.sessionId), null);
  });
}
