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
  const receiver = record.roles.find(role => role.role === "receiver-b1");
  if (receiver) assert.ok(receiver.participantId && receiver.threadId,
    "receiver-b1 must be identified before scenario snapshot");
  return { record, check(condition, message) {
    record.assertionCount += 1; assert.ok(condition, message);
  }, equal(actual, expected, message) {
    const index = ++record.assertionCount;
    const detail = typeof message === "string" && message !== "" ? message : "deep equality mismatch";
    try {
      if (message === undefined) assert.deepEqual(actual, expected);
      else assert.deepEqual(actual, expected, message);
    } catch {
      throw new Error(`scenario ${caseId} assertion ${index} failed: ${detail}`);
    }
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
