import assert from "node:assert/strict";
import test from "node:test";

import { scenario } from "../../scripts/e2e/codex-local-daemon-observations.mjs";

const harness = participantId => ({ phase: "product", version: "0.152.1",
  packageSha256: "a".repeat(64), scenarios: [], roles: {
    "receiver-b1": { role: "receiver-b1", participantId, threadId: "thread_p13" },
  } });

test("P13 cannot snapshot receiver-b1 before its observed identity is resolved", () => {
  assert.doesNotThrow(() => scenario(harness(null), "P01"),
    "P01 snapshots before its deliberate independent identity refresh");
  assert.throws(() => scenario(harness(null), "P13"),
    /receiver-b1 must be identified before scenario snapshot/);

  const h = harness("participant_p13");
  const record = scenario(h, "P13").record;
  h.roles["receiver-b1"].participantId = "later-participant";
  assert.deepEqual(record.roles.find(role => role.role === "receiver-b1"),
    { role: "receiver-b1", participantId: "participant_p13", threadId: "thread_p13" });
});
