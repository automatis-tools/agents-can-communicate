const fact = (kind, actor, target, outcome) => ({ kind, actor, target, outcome });

// Hand-derived literals: test fixtures must not reuse REQUIRED_OBSERVATIONS from
// the validator or an incorrect production contract would build its own passing proof.
export const EXPECTED_CASE_FACTS = {
  P01: [fact("installed-runtime", "receiver-b1", null, "observed"),
    fact("workspace", "receiver-b1", "receiver-b1", "matched"),
    fact("hook-cwd", "receiver-b1", "receiver-b1", "matched"),
    fact("thread-cwd", "receiver-b1", "receiver-b1", "matched"),
    fact("actual-cwd", "receiver-b1", "receiver-b1", "matched"),
    fact("actual-cwd", "daemon-a", "daemon-a", "matched"),
    fact("participant", "receiver-b1", "daemon-a", "absent")],
  P02: [fact("message", "receiver-b1", null, "one")],
  P03: [fact("receipt", "receiver-b1", null, "offered")],
  P04: [fact("lease", "receiver-b1", null, "fresh")],
  P05: [fact("session-state", "receiver-b1", null, "active"),
    fact("queue", "receiver-b1", null, "pending"),
    fact("marker-order", "receiver-b1", "receiver-b1", "before")],
  P06: [fact("receipt", "receiver-b1", null, "acknowledged")],
  P07: [fact("message", "receiver-b1", null, "one")],
  P08: [fact("policy", "receiver-b1", null, "observed")],
  P09: [fact("policy", "receiver-b1", null, "disabled")],
  P10: [fact("binding", "receiver-b1", null, "absent")],
  P11: [fact("daemon", "daemon-a", null, "stopped")],
  P12: [fact("actual-cwd", "daemon-a", "daemon-a", "matched")],
  P13: [fact("launch-arguments", "receiver-b1", null, "unchanged")],
  P14: [fact("binding", "receiver-b1", null, "retired")],
  P15: [fact("binding", "sender", "receiver-b1", "matched")],
  P16: [fact("diagnostic", "receiver-b1", null, "sanitized")],
  P17: [fact("message", "receiver-b1", null, "one")],
  P18: [fact("artifact", "daemon-a", null, "preserved")],
  P19: [fact("consent", "receiver-b1", null, "removed")],
  P20: [fact("path", "receiver-b1", null, "observed")],
  T01: [fact("binding", "receiver-b1", "receiver-b1", "matched")],
  T02: [fact("submission", "receiver-b1", null, "accepted")],
  T03: [fact("session-state", "receiver-b1", null, "active"),
    fact("queue", "receiver-b1", null, "pending"),
    fact("submission", "receiver-b1", null, "accepted")],
  T04: [fact("submission", "receiver-b1", null, "rejected"),
    fact("receipt", "receiver-b1", null, "queued")],
};

export const PRODUCT_IDS = Object.freeze(Object.keys(EXPECTED_CASE_FACTS)
  .filter(id => id.startsWith("P")));
export const TRANSPORT_IDS = Object.freeze(Object.keys(EXPECTED_CASE_FACTS)
  .filter(id => id.startsWith("T")));
export const CLEANUP = Object.freeze({ attempted: true, outcome: "passed",
  ownedProcesses: "stopped", temporaryState: "removed" });
const START = "2026-09-08T12:00:00.000Z";

export function evidenceScenario(caseId, overrides = {}) {
  const phase = caseId.startsWith("P") ? "product" : "transport";
  const timestamps = { startedAt: START, idleSinceAt: null, preToolUseAt: null,
    queuedAt: null, stopAt: null, nextTurnAt: null,
    finishedAt: "2026-09-08T12:03:00.000Z" };
  if (caseId === "P04") timestamps.idleSinceAt = START;
  if (["P05", "T03"].includes(caseId)) Object.assign(timestamps, {
    preToolUseAt: "2026-09-08T12:00:01.000Z", queuedAt: "2026-09-08T12:00:02.000Z",
    stopAt: "2026-09-08T12:00:03.000Z", nextTurnAt: "2026-09-08T12:00:04.000Z" });
  const observations = EXPECTED_CASE_FACTS[caseId].map(item => ({ ...item, at: START }));
  return { schemaVersion: 1, source: "synthetic-unit-fixture", caseId, phase,
    client: "codex-cli", clientVersion: "0.152.1", platform: "darwin-arm64",
    packageSha256: "a".repeat(64), roles: [
      { role: "daemon-a", participantId: null, threadId: null },
      { role: "receiver-b1", participantId: "participant-b1", threadId: "thread-b1" },
      { role: "sender", participantId: "participant-s", threadId: "thread-s" }],
    timestamps, outcome: "passed", observations, observationCount: observations.length,
    assertionCount: 1, cleanup: { ...CLEANUP }, ...overrides };
}

export function matrixEvidence(phase = "product", overrides = {}) {
  const ids = phase === "product" ? PRODUCT_IDS : TRANSPORT_IDS;
  const source = overrides.source ?? "real-client-capture";
  const scenarios = ids.map(caseId => evidenceScenario(caseId, { source }));
  return { schemaVersion: 1, source, phase, client: "codex-cli", clientVersion: "0.152.1",
    platform: "darwin-arm64", packageSha256: "a".repeat(64), startedAt: START,
    finishedAt: "2026-09-08T13:00:00.000Z", scenarioCount: scenarios.length,
    passedCount: scenarios.length, failedCount: 0, cleanup: { ...CLEANUP }, scenarios,
    ...overrides };
}
