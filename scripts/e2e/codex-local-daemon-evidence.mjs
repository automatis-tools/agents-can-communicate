// Closed, redacted evidence contract for the installed Codex LocalDaemon matrix.
// Values describe observations only; there is intentionally no prompt, body,
// transcript, protocol payload, credential, or raw path field.

export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_SOURCES = Object.freeze([
  "synthetic-unit-fixture", "real-client-capture",
]);
export const PRODUCT_CASE_IDS = Object.freeze(
  Array.from({ length: 20 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`));
export const TRANSPORT_CASE_IDS = Object.freeze(
  Array.from({ length: 4 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`));

export const EVIDENCE_ROLES = Object.freeze([
  "daemon-a", "receiver-b1", "receiver-b2", "unrelated-c1", "sender",
]);
export const OBSERVATION_KINDS = Object.freeze([
  "installed-runtime", "workspace", "hook-cwd", "thread-cwd", "actual-cwd",
  "participant", "hook-event", "session-state", "receipt", "queue", "marker-order",
  "binding", "submission", "answer", "obligation", "policy", "daemon", "diagnostic",
  "consent", "artifact", "path", "launch-arguments", "instrumentation", "lease", "message",
]);
export const OBSERVATION_OUTCOMES = Object.freeze([
  "observed", "not-observed", "matched", "mismatched", "present", "absent", "recorded",
  "queued", "offered", "retrieved", "acknowledged", "active", "idle", "retired",
  "accepted", "rejected", "before", "after", "unchanged", "running", "stopped",
  "enabled", "disabled", "sanitized", "resolved", "preserved", "removed", "failed",
  "passed", "supported", "unsupported", "one", "zero", "pending", "fresh",
]);

const fact = (kind, actor, target, outcome) => Object.freeze({ kind, actor, target, outcome });
const REQUIRED = {
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
export const REQUIRED_OBSERVATIONS = Object.freeze(Object.fromEntries(
  Object.entries(REQUIRED).map(([id, facts]) => [id, Object.freeze(facts)])));

const SCENARIO_FIELDS = ["schemaVersion", "source", "caseId", "phase", "clientVersion",
  "platform", "packageSha256", "roles", "timestamps", "outcome", "observations",
  "observationCount", "assertionCount", "cleanup"];
const RUN_FIELDS = ["schemaVersion", "source", "phase", "clientVersion", "platform",
  "packageSha256", "startedAt", "finishedAt", "scenarioCount", "passedCount",
  "failedCount", "cleanup", "scenarios"];
const ROLE_FIELDS = ["role", "participantId", "threadId"];
const TIME_FIELDS = ["startedAt", "idleSinceAt", "preToolUseAt", "queuedAt", "stopAt",
  "nextTurnAt", "finishedAt"];
const OBSERVATION_FIELDS = ["kind", "at", "actor", "target", "outcome"];
const CLEANUP_FIELDS = ["attempted", "outcome", "ownedProcesses", "temporaryState"];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLATFORM = /^(darwin|linux|win32)-(arm64|x64)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function assertScenarioEvidence(value) {
  objectWithFields(value, SCENARIO_FIELDS, "scenario");
  expect(value.schemaVersion === EVIDENCE_SCHEMA_VERSION, "scenario schemaVersion is 1");
  expect(EVIDENCE_SOURCES.includes(value.source), "scenario source is closed");
  const caseIds = [...PRODUCT_CASE_IDS, ...TRANSPORT_CASE_IDS];
  expect(caseIds.includes(value.caseId), "scenario caseId is required and closed");
  const expectedPhase = value.caseId.startsWith("P") ? "product" : "transport";
  expect(value.phase === expectedPhase, `scenario ${value.caseId} phase is ${expectedPhase}`);
  expect(matches(VERSION, value.clientVersion), "scenario clientVersion is exact semver");
  expect(matches(PLATFORM, value.platform), "scenario platform is closed");
  expect(matches(SHA256, value.packageSha256), "scenario packageSha256 is lowercase SHA-256");
  const roleNames = validateRoles(value.roles);
  validateTimestamps(value.timestamps);
  expect(["passed", "failed"].includes(value.outcome), "scenario outcome is passed or failed");
  expect(Array.isArray(value.observations) && value.observations.length > 0,
    "scenario has at least one observation");
  let previous = -Infinity;
  for (const item of value.observations) {
    objectWithFields(item, OBSERVATION_FIELDS, "observation");
    expect(OBSERVATION_KINDS.includes(item.kind), "observation kind is closed");
    expect(timestamp(item.at), "observation at is a UTC timestamp");
    expect(Date.parse(item.at) >= previous, "scenario observations are timestamp ordered");
    previous = Date.parse(item.at);
    expect(roleNames.has(item.actor), "observation actor names a scenario role");
    expect(item.target === null || roleNames.has(item.target),
      "observation target is null or a scenario role");
    expect(OBSERVATION_OUTCOMES.includes(item.outcome), "observation outcome is closed");
  }
  expect(value.observationCount === value.observations.length && value.observationCount > 0,
    "scenario observationCount matches observations");
  expect(Number.isSafeInteger(value.assertionCount) && value.assertionCount > 0,
    "scenario has a positive assertionCount");
  validateCleanup(value.cleanup, value.outcome === "passed");
  for (const required of REQUIRED_OBSERVATIONS[value.caseId]) {
    expect(value.observations.some(item => sameFact(item, required)),
      `${value.caseId} requires ${required.kind} ${required.actor} ${required.target ?? "null"} ${required.outcome}`);
  }
  validateCaseRules(value);
  return immutableClone(value);
}

export function assertRunEvidence(value) {
  objectWithFields(value, RUN_FIELDS, "run");
  expect(value.schemaVersion === EVIDENCE_SCHEMA_VERSION, "run schemaVersion is 1");
  expect(EVIDENCE_SOURCES.includes(value.source), "run source is closed");
  expect(["product", "transport"].includes(value.phase), "run phase is product or transport");
  expect(matches(VERSION, value.clientVersion), "run clientVersion is exact semver");
  expect(matches(PLATFORM, value.platform), "run platform is closed");
  expect(matches(SHA256, value.packageSha256), "run packageSha256 is lowercase SHA-256");
  expect(timestamp(value.startedAt) && timestamp(value.finishedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt), "run timestamps are ordered");
  expect(Array.isArray(value.scenarios), "run scenarios is an array");
  const required = value.phase === "product" ? PRODUCT_CASE_IDS : TRANSPORT_CASE_IDS;
  for (const caseId of required) {
    expect(value.scenarios.some(item => item?.caseId === caseId), `run requires case ${caseId}`);
  }
  expect(value.scenarios.length === required.length
    && new Set(value.scenarios.map(item => item?.caseId)).size === required.length,
  "run has exactly one of every required case");
  const scenarios = value.scenarios.map(assertScenarioEvidence);
  for (const item of scenarios) {
    for (const key of ["source", "phase", "clientVersion", "platform", "packageSha256"]) {
      expect(item[key] === value[key], `scenario ${key} matches run`);
    }
  }
  const passed = scenarios.filter(item => item.outcome === "passed").length;
  expect(value.scenarioCount === scenarios.length && value.passedCount === passed
    && value.failedCount === scenarios.length - passed, "run scenario counts match");
  validateCleanup(value.cleanup, value.failedCount === 0);
  return immutableClone(value);
}

function validateRoles(roles) {
  expect(Array.isArray(roles), "scenario roles is an array");
  const names = new Set();
  for (const role of roles) {
    objectWithFields(role, ROLE_FIELDS, "role");
    expect(EVIDENCE_ROLES.includes(role.role) && !names.has(role.role), "scenario roles are closed and unique");
    names.add(role.role);
    for (const key of ["participantId", "threadId"]) {
      expect(role[key] === null || matches(ID, role[key]), `role ${key} is a redacted identifier or null`);
    }
    if (role.role === "daemon-a") {
      expect(role.participantId === null, "daemon-a has no participantId");
      expect(role.threadId === null, "daemon-a has no threadId");
    }
  }
  expect(names.has("daemon-a") && names.has("receiver-b1"),
    "scenario roles include daemon-a and receiver-b1");
  const receiver = roles.find(role => role.role === "receiver-b1");
  expect(receiver.participantId !== null && receiver.threadId !== null,
    "receiver-b1 has participantId and threadId");
  return names;
}

function validateTimestamps(value) {
  objectWithFields(value, TIME_FIELDS, "timestamps");
  expect(timestamp(value.startedAt) && timestamp(value.finishedAt),
    "timestamps startedAt and finishedAt are UTC timestamps");
  const start = Date.parse(value.startedAt);
  const finish = Date.parse(value.finishedAt);
  expect(start <= finish, "timestamps startedAt precedes finishedAt");
  for (const key of TIME_FIELDS.slice(1, -1)) {
    expect(value[key] === null || timestamp(value[key]), `timestamps ${key} is UTC or null`);
    if (value[key] !== null) expect(Date.parse(value[key]) >= start && Date.parse(value[key]) <= finish,
      `timestamps ${key} is within scenario bounds`);
  }
}

function validateCleanup(value, mustPass) {
  objectWithFields(value, CLEANUP_FIELDS, "cleanup");
  expect(value.attempted === true, "cleanup was attempted");
  expect(["passed", "failed"].includes(value.outcome), "cleanup outcome is closed");
  expect(["stopped", "failed"].includes(value.ownedProcesses), "cleanup ownedProcesses is closed");
  expect(["removed", "failed"].includes(value.temporaryState), "cleanup temporaryState is closed");
  if (mustPass) expect(value.outcome === "passed" && value.ownedProcesses === "stopped"
    && value.temporaryState === "removed", "passing scenario requires successful cleanup");
}

function validateCaseRules(value) {
  if (value.caseId === "P04") {
    expect(value.timestamps.idleSinceAt !== null
      && Date.parse(value.timestamps.finishedAt) - Date.parse(value.timestamps.idleSinceAt) >= 150_000,
    "P04 observes at least 150 seconds idle");
  }
  if (["P05", "T03"].includes(value.caseId)) {
    const { preToolUseAt, queuedAt, stopAt, nextTurnAt } = value.timestamps;
    expect([preToolUseAt, queuedAt, stopAt, nextTurnAt].every(item => item !== null)
      && Date.parse(preToolUseAt) <= Date.parse(queuedAt)
      && Date.parse(queuedAt) < Date.parse(stopAt)
      && Date.parse(stopAt) <= Date.parse(nextTurnAt),
    `${value.caseId} requires preToolUseAt <= queuedAt < stopAt <= nextTurnAt`);
  }
}

function objectWithFields(value, fields, name) {
  expect(value && typeof value === "object" && !Array.isArray(value), `${name} is an object`);
  for (const key of Object.keys(value)) expect(fields.includes(key), `${name} has unknown field ${key}`);
  for (const key of fields) expect(Object.hasOwn(value, key), `${name} requires ${key}`);
}
function timestamp(value) { return matches(UTC, value) && !Number.isNaN(Date.parse(value)); }
function matches(pattern, value) { return typeof value === "string" && pattern.test(value); }
function sameFact(item, required) { return OBSERVATION_FIELDS
  .filter(key => key !== "at").every(key => item[key] === required[key]); }
function immutableClone(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { Object.freeze(value); for (const item of Object.values(value)) {
  if (item && typeof item === "object" && !Object.isFrozen(item)) deepFreeze(item);
} return value; }
function expect(condition, message) { if (!condition) throw new Error(message); }
