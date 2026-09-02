import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-02T08:00:00.000Z";
const WORKSPACE = "workspace_materialisation_race";

const opening = (participantId, sessionId) => ({
  workspaceId: WORKSPACE,
  participantId,
  sessionId,
  displayName: participantId,
  harness: "test",
  heartbeatCadenceMs: 60_000,
});

test("an attach that writes after materialisation staging is promoted to the durable roster",
  async () => {
    const clock = createFakeClock(NOW);
    const ids = createFakeIds();
    const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
    const service = createCoordinationService({ store, clock, ids });
    await service.openSession(opening("first", "session_first"));

    let materialisedBetweenPrecheckAndPut = false;
    const ephemeral = { ...store.ephemeral,
      async put(kind, id, record) {
        if (!materialisedBetweenPrecheckAndPut
          && kind === "participant" && id === "late") {
          materialisedBetweenPrecheckAndPut = true;
          await service.openSession(opening("second", "session_second"));
        }
        return store.ephemeral.put(kind, id, record);
      },
    };
    const racing = createCoordinationService({ store: { ...store, ephemeral }, clock, ids });

    await racing.openSession(opening("late", "session_late"));

    const snapshot = await store.snapshot(WORKSPACE);
    assert.equal(materialisedBetweenPrecheckAndPut, true);
    assert.deepEqual(snapshot.sessions.map(session => session.sessionId).sort(),
      ["session_first", "session_late", "session_second"]);
    assert.deepEqual((await service.sync({ workspaceId: WORKSPACE })).roster
      .map(session => session.sessionId).sort(),
    ["session_first", "session_late", "session_second"]);
    assert.equal(await store.ephemeral.get("session", "session_late"), null);
  });
