import assert from "node:assert/strict";

export function scenario(h, caseId) {
  const startedAt = new Date().toISOString();
  const record = { schemaVersion: 1, source: "real-client-capture", client: "codex-cli", caseId, phase: h.phase,
    clientVersion: h.version, platform: `${process.platform}-${process.arch}`,
    packageSha256: h.packageSha256,
    roles: [{ role: "daemon-a", participantId: null, threadId: null },
      ...Object.values(h.roles).map(role => ({ role: role.role,
        participantId: role.participantId ?? null, threadId: role.threadId ?? null }))],
    timestamps: { startedAt, idleSinceAt: null, preToolUseAt: null, queuedAt: null,
      stopAt: null, nextTurnAt: null, finishedAt: null }, outcome: "failed",
    observations: [], observationCount: 0, assertionCount: 0, cleanup: null };
  return { record, check(condition, message) {
    record.assertionCount += 1; assert.ok(condition, message);
  }, equal(actual, expected, message) {
    record.assertionCount += 1; assert.deepEqual(actual, expected, message);
  }, fact(kind, outcome, actor = "receiver-b1", target = null) {
    record.observations.push({ kind, at: new Date().toISOString(), actor, target, outcome });
  }, finish() {
    record.timestamps.finishedAt = new Date().toISOString();
    record.observationCount = record.observations.length;
    record.outcome = "passed";
    h.scenarios.push(record);
    console.log(JSON.stringify({ phase: h.phase, caseId, outcome: "passed", assertions: record.assertionCount }));
    return record;
  } };
}
