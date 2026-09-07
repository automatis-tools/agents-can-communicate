import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

test("installed resume cannot cross workspace boundaries", async t => {
  const packed = await createPackedAcc(t);
  const load = name => import(pathToFileURL(path.join(packed.installed, "node_modules",
    "@agents-can-communicate", name, "src", "index.mjs")).href);
  const { createCoordinationService } = await load("core");
  const { openFilesystemStore } = await load("storage-filesystem");
  const { createId } = await load("protocol");
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind) };
  const workspaceId = "workspace_resume_scope";
  for (const mode of ["ephemeral", "durable"]) {
    await t.test(`${mode} resume refuses the wrong workspace without changing metadata`, async () => {
      const store = await openFilesystemStore({ root: path.join(packed.root, mode),
        workspaceId, clock, ids });
      const service = createCoordinationService({ store, clock, ids });
      const opening = participantId => ({ workspaceId, participantId,
        harness: "fixture", heartbeatCadenceMs: 60_000 });
      const original = await service.openSession(opening("writer"));
      if (mode === "durable") await service.openSession(opening("peer"));
      const inspect = async () => ({ durable: await store.snapshot(workspaceId),
        ephemeral: await store.ephemeral.list("session"),
        events: await store.eventsSince(workspaceId, null, 100) });
      const before = await inspect();
      const input = { sessionId: original.sessionId, generation: original.generation,
        pid: process.pid, checkoutRoot: "/current-checkout", branch: "current" };
      assert.equal(await service.resumeSession({ ...input, workspaceId: "workspace_wrong" }), null);
      assert.deepEqual(await inspect(), before);
      const resumed = await service.resumeSession({ ...input, workspaceId });
      assert.equal(resumed.generation, original.generation);
      assert.equal(resumed.pid, process.pid);
      assert.equal(resumed.checkoutRoot, "/current-checkout");
      assert.equal(resumed.branch, "current");
      assert.deepEqual((await inspect()).events, before.events);
    });
  }
});
