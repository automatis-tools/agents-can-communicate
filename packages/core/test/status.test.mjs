import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";
const CADENCE = 30_000;

function makeService() {
  const clock = createFakeClock(NOW);
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: WORKSPACE });
  return { clock, store,
    service: createCoordinationService({ store, clock, ids: createFakeIds() }) };
}

const opening = (overrides = {}) => ({ workspaceId: WORKSPACE,
  participantId: "participant_a", displayName: "visual", harness: "codex",
  heartbeatCadenceMs: CADENCE, ...overrides });

test("a session records what its harness can actually enforce", async () => {
  const { service } = makeService();

  await service.openSession(opening({ participantId: "guarded_one",
    enforcement: "guarded", lifecycle: "managed" }));
  const status = await service.collectStatus({ workspaceId: WORKSPACE });

  // A peer deciding whether to rely on a claim needs to know whether the other
  // session's writes can be stopped at all. Harness name alone does not say:
  // the same client guards or does not depending on its model and its config.
  const [participant] = status.participants;
  assert.equal(participant.enforcement, "guarded");
  assert.equal(participant.lifecycle, "managed");
});

test("a participant that cannot be guarded says so, rather than staying silent", async () => {
  const { service } = makeService();

  await service.openSession(opening({ participantId: "mcp_only", harness: "mcp" }));
  const status = await service.collectStatus({ workspaceId: WORKSPACE });

  // An MCP client has no hooks: nothing intercepts its writes and nothing
  // closes its session. Defaulting to "advisory" and "manual" is the honest
  // reading of a session that declared nothing.
  const [participant] = status.participants;
  assert.equal(participant.enforcement, "advisory");
  assert.equal(participant.lifecycle, "manual");
});

test("one unguarded participant makes the whole workspace advisory", async () => {
  const { service } = makeService();
  const guarded = await service.openSession(opening({ participantId: "guarded_one",
    enforcement: "guarded", lifecycle: "managed" }));
  await service.acquireClaim({ sessionId: guarded.sessionId,
    generation: guarded.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "porting" });

  const before = await service.collectStatus({ workspaceId: WORKSPACE });
  assert.equal(before.protection, "guarded");

  await service.openSession(opening({ participantId: "mcp_only", harness: "mcp" }));
  const after = await service.collectStatus({ workspaceId: WORKSPACE });

  // The claim is still guarded, and it no longer protects the workspace: the
  // new session cannot be stopped from writing straight through it. Reporting
  // "guarded" here would promise enforcement that demonstrably is not there.
  assert.equal(after.protection, "advisory");
});

test("protection is none when nothing is claimed at all", async () => {
  const { service } = makeService();
  await service.openSession(opening({ enforcement: "guarded", lifecycle: "managed" }));

  assert.equal((await service.collectStatus({ workspaceId: WORKSPACE })).protection, "none");
});

test("a closed session stops weakening the workspace", async () => {
  const { service } = makeService();
  const guarded = await service.openSession(opening({ participantId: "guarded_one",
    enforcement: "guarded", lifecycle: "managed" }));
  await service.acquireClaim({ sessionId: guarded.sessionId,
    generation: guarded.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "porting" });
  const loose = await service.openSession(opening({ participantId: "mcp_only",
    harness: "mcp" }));
  assert.equal((await service.collectStatus({ workspaceId: WORKSPACE })).protection,
    "advisory");

  await service.closeSession({ sessionId: loose.sessionId, generation: loose.generation });

  assert.equal((await service.collectStatus({ workspaceId: WORKSPACE })).protection,
    "guarded");
});

test("an unknown enforcement value is refused rather than trusted", async () => {
  const { service } = makeService();

  await assert.rejects(service.openSession(opening({ enforcement: "probably" })));
});
