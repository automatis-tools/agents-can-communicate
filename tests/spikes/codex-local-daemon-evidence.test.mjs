import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_SOURCES,
  PRODUCT_CASE_IDS,
  REQUIRED_OBSERVATIONS,
  TRANSPORT_CASE_IDS,
  assertRunEvidence,
  assertScenarioEvidence,
} from "../../scripts/e2e/codex-local-daemon-evidence.mjs";

const SHA = "a".repeat(64);
const AT = Object.freeze({
  startedAt: "2026-09-08T12:00:00.000Z",
  idleSinceAt: null,
  preToolUseAt: null,
  queuedAt: null,
  stopAt: null,
  nextTurnAt: null,
  finishedAt: "2026-09-08T12:00:10.000Z",
});
const CLEAN = Object.freeze({ attempted: true, outcome: "passed",
  ownedProcesses: "stopped", temporaryState: "removed" });
const ROLES = Object.freeze([
  { role: "daemon-a", participantId: null, threadId: null },
  { role: "receiver-b1", participantId: "participant-b1", threadId: "thread-b1" },
  { role: "sender", participantId: "participant-sender", threadId: "thread-sender" },
]);

function observation(kind, actor, target, outcome, at = AT.startedAt) {
  return { kind, at, actor, target, outcome };
}

function requiredObservations(caseId) {
  return REQUIRED_OBSERVATIONS[caseId].map(({ kind, actor, target, outcome }) =>
    observation(kind, actor, target, outcome));
}

function scenario(caseId, overrides = {}) {
  const phase = caseId.startsWith("P") ? "product" : "transport";
  const observations = requiredObservations(caseId);
  const timestamps = caseId === "P04" ? { ...AT,
    idleSinceAt: "2026-09-08T12:00:00.000Z", finishedAt: "2026-09-08T12:02:30.000Z" }
    : ["P05", "T03"].includes(caseId) ? { ...AT,
      preToolUseAt: "2026-09-08T12:00:01.000Z",
      queuedAt: "2026-09-08T12:00:02.000Z",
      stopAt: "2026-09-08T12:00:03.000Z",
      nextTurnAt: "2026-09-08T12:00:04.000Z" }
      : { ...AT };
  return {
    schemaVersion: 1,
    source: "synthetic-unit-fixture",
    caseId,
    phase,
    clientVersion: "0.152.1",
    platform: "darwin-arm64",
    packageSha256: SHA,
    roles: ROLES.map(role => ({ ...role })),
    timestamps,
    outcome: "passed",
    observations,
    observationCount: observations.length,
    assertionCount: 1,
    cleanup: { ...CLEAN },
    ...overrides,
  };
}

function run(phase, overrides = {}) {
  const ids = phase === "product" ? PRODUCT_CASE_IDS : TRANSPORT_CASE_IDS;
  const scenarios = ids.map(caseId => scenario(caseId));
  return {
    schemaVersion: 1,
    source: "synthetic-unit-fixture",
    phase,
    clientVersion: "0.152.1",
    platform: "darwin-arm64",
    packageSha256: SHA,
    startedAt: AT.startedAt,
    finishedAt: "2026-09-08T13:00:00.000Z",
    scenarioCount: scenarios.length,
    passedCount: scenarios.length,
    failedCount: 0,
    cleanup: { ...CLEAN },
    scenarios,
    ...overrides,
  };
}

test("synthetic unit fixtures satisfy the closed scenario and run contracts", () => {
  assert.deepEqual(assertScenarioEvidence(scenario("P02")), scenario("P02"));
  assert.deepEqual(assertRunEvidence(run("product")), run("product"));
  assert.deepEqual(assertRunEvidence(run("transport")), run("transport"));
  assert.deepEqual([...EVIDENCE_SOURCES], ["synthetic-unit-fixture", "real-client-capture"]);
});

test("an empty or incomplete scenario list cannot stand in for the required matrix", () => {
  for (const phase of ["product", "transport"]) {
    const evidence = run(phase, { scenarios: [], scenarioCount: 0,
      passedCount: 0, failedCount: 0 });
    assert.throws(() => assertRunEvidence(evidence), /requires case/);
  }
  const evidence = run("product");
  evidence.scenarios.pop();
  evidence.scenarioCount -= 1;
  evidence.passedCount -= 1;
  assert.throws(() => assertRunEvidence(evidence), /requires case P20/);
});

test("P01 proves daemon A and receiver B separation with installed B hooks", () => {
  const valid = scenario("P01");
  assert.doesNotThrow(() => assertScenarioEvidence(valid));
  assert.equal(valid.roles[0].participantId, null);
  assert.equal(valid.roles[0].threadId, null);

  const equalized = scenario("P01");
  const actualB = equalized.observations.find(item =>
    item.kind === "actual-cwd" && item.actor === "receiver-b1");
  actualB.target = "daemon-a";
  assert.throws(() => assertScenarioEvidence(equalized), /P01 requires actual-cwd receiver-b1/);

  const inventedDaemon = scenario("P01");
  inventedDaemon.roles[0].participantId = "invented-daemon-participant";
  assert.throws(() => assertScenarioEvidence(inventedDaemon), /daemon-a has no participantId/);
});

test("P04 proves an idle interval of at least 150 seconds", () => {
  const short = scenario("P04", { timestamps: { ...AT,
    idleSinceAt: "2026-09-08T12:00:00.000Z",
    finishedAt: "2026-09-08T12:02:29.999Z" } });
  assert.throws(() => assertScenarioEvidence(short), /P04 observes at least 150 seconds idle/);

  const enough = scenario("P04", { timestamps: { ...AT,
    idleSinceAt: "2026-09-08T12:00:00.000Z",
    finishedAt: "2026-09-08T12:02:30.000Z" } });
  assert.doesNotThrow(() => assertScenarioEvidence(enough));
});

test("P05 proves the busy queue and hook ordering rather than a sleep", () => {
  const timestamps = { ...AT,
    preToolUseAt: "2026-09-08T12:00:01.000Z",
    queuedAt: "2026-09-08T12:00:02.000Z",
    stopAt: "2026-09-08T12:00:03.000Z",
    nextTurnAt: "2026-09-08T12:00:04.000Z" };
  assert.doesNotThrow(() => assertScenarioEvidence(scenario("P05", { timestamps })));
  const lateQueue = scenario("P05", { timestamps: { ...timestamps,
    queuedAt: "2026-09-08T12:00:03.001Z" } });
  assert.throws(() => assertScenarioEvidence(lateQueue),
    /P05 requires preToolUseAt <= queuedAt < stopAt <= nextTurnAt/);
});

test("scenario evidence rejects zero observations, missing package identity and secret-shaped fields", () => {
  assert.throws(() => assertScenarioEvidence(scenario("P02", {
    observations: [], observationCount: 0 })), /at least one observation/);
  assert.throws(() => assertScenarioEvidence(scenario("P02", { packageSha256: undefined })),
    /packageSha256/);
  for (const extra of [{ prompt: "secret" }, { transcript: [] }, { body: "secret" },
    { arbitrary: true }]) {
    assert.throws(() => assertScenarioEvidence({ ...scenario("P02"), ...extra }),
      /unknown field/);
  }
});

test("observation vocabulary, timestamps, counts and cleanup are closed and honest", () => {
  const unknown = scenario("P02");
  unknown.observations[0].outcome = "probably";
  assert.throws(() => assertScenarioEvidence(unknown), /observation outcome/);
  const unordered = scenario("P02");
  unordered.observations.push(observation("message", "receiver-b1", null, "observed",
    "2026-09-08T11:59:59.000Z"));
  unordered.observationCount += 1;
  assert.throws(() => assertScenarioEvidence(unordered), /observations are timestamp ordered/);
  assert.throws(() => assertScenarioEvidence(scenario("P02", { assertionCount: 0 })),
    /positive assertionCount/);
  assert.throws(() => assertScenarioEvidence(scenario("P02", {
    cleanup: { ...CLEAN, outcome: "failed" } })), /passing scenario requires successful cleanup/);
});

test("transport cases require exact binding, idle, busy and durable fallback observations", () => {
  for (const caseId of TRANSPORT_CASE_IDS) {
    const evidence = scenario(caseId);
    evidence.observations.pop();
    evidence.observationCount -= 1;
    if (evidence.observations.length === 0) {
      evidence.observations.push(observation("message", "receiver-b1", null, "observed"));
      evidence.observationCount += 1;
    }
    assert.throws(() => assertScenarioEvidence(evidence), new RegExp(`${caseId} requires`));
  }
});

test("T03 proves active queue timing through Stop and the next turn", () => {
  const invalid = scenario("T03");
  invalid.timestamps.queuedAt = "2026-09-08T12:00:03.001Z";
  assert.throws(() => assertScenarioEvidence(invalid),
    /T03 requires preToolUseAt <= queuedAt < stopAt <= nextTurnAt/);
});

test("run aggregates reject mismatched metadata and failed count arithmetic", () => {
  const missingSha = run("product");
  delete missingSha.packageSha256;
  assert.throws(() => assertRunEvidence(missingSha), /packageSha256/);
  const mismatch = run("product");
  mismatch.scenarios[1].clientVersion = "0.153.4";
  assert.throws(() => assertRunEvidence(mismatch), /scenario clientVersion matches run/);
  assert.throws(() => assertRunEvidence(run("product", { passedCount: 19, failedCount: 0 })),
    /scenario counts match/);
});
