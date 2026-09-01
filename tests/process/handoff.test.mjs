import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../../packages/core/src/service.mjs";
import { openFilesystemStore } from "../../packages/storage-filesystem/src/store.mjs";
import { createFakeClock, createFakeIds } from "../helpers/memory-store.mjs";

const WORKSPACE = "workspace_handoff_v2";

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-handoff-v2-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock("2026-09-01T22:00:00.000Z");
  const ids = createFakeIds();
  const store = await openFilesystemStore({ root, clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids });
  const opening = participantId => ({ workspaceId: WORKSPACE, participantId,
    displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000 });
  const leaving = await service.openSession(opening("leaving"));
  await service.openSession(opening("successor"));
  return { store, service, leaving };
}

const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

test("finish commits one structured handoff with release and close", async t => {
  const { store, service, leaving } = await place(t);
  await service.acquireClaim({ ...owner(leaving), resource: "file:src/**",
    reason: "porting" });

  const result = await service.finishSession({ ...owner(leaving),
    clientMessageId: "client_process_finish", toParticipantId: "successor",
    goal: "port the material slots", status: "partial", completed: ["slots ported"],
    remaining: ["physics review"], blockers: ["clamp decision"], verification: [],
    artifacts: [] });

  assert.deepEqual(result.message.handoff, { status: "partial",
    completed: ["slots ported"], remaining: ["physics review"],
    blockers: ["clamp decision"], verification: [] });
  assert.deepEqual(result.releasedClaims.map(item => item.resource), ["file:src/**"]);
  assert.equal(result.session.state, "closed");
  const snapshot = await store.snapshot(WORKSPACE);
  assert.deepEqual(snapshot.claims, []);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.receipts[0].recipientParticipantId, "successor");
});

test("an unknown successor rolls back the handoff, release, and close", async t => {
  const { store, service, leaving } = await place(t);
  await service.acquireClaim({ ...owner(leaving), resource: "file:src/**",
    reason: "porting" });

  await assert.rejects(service.finishSession({ ...owner(leaving),
    clientMessageId: "client_bad_successor", toParticipantId: "sucessor",
    goal: "typo", completed: [], remaining: [], blockers: [], verification: [], artifacts: [] }),
  error => error.code === EXIT.DATA && /no participant here/.test(error.message));

  const snapshot = await store.snapshot(WORKSPACE);
  assert.deepEqual(snapshot.messages, []);
  assert.equal(snapshot.claims.length, 1);
  assert.equal(snapshot.sessions.find(item => item.sessionId === leaving.sessionId).state, "open");
});
