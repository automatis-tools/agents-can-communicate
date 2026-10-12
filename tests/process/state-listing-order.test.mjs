import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCoordinationService } from "../../packages/core/src/service.mjs";
import { openFilesystemStore } from "../../packages/storage-filesystem/src/store.mjs";
import { createFakeClock, createFakeIds } from "../helpers/memory-store.mjs";

// Records of one kind are read several at a time (#298); a listing still comes
// back in the order of its file names, whichever read finishes first.
test("a listing read in parallel keeps the order of its file names", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-list-order-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceId = "workspace_list_order";
  const clock = createFakeClock("2026-10-12T21:00:00.000Z"), ids = createFakeIds();
  const store = await openFilesystemStore({ root, workspaceId, clock, ids });
  const service = createCoordinationService({ store, clock, ids });
  for (let i = 0; i < 40; i += 1) {
    await service.openSession({ workspaceId, participantId: `peer${i}`, harness: "fixture",
      heartbeatCadenceMs: 60_000 });
  }
  const listed = (await store.snapshot(workspaceId)).sessions.map(session => session.sessionId);
  assert.equal(listed.length, 40);
  assert.deepEqual(listed, [...listed].sort((left, right) =>
    path.join(root, `${left}.json`).localeCompare(path.join(root, `${right}.json`))));
});
