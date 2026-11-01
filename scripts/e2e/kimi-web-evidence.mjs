// Closed installed-product evidence for the Kimi Web prompt wake.
// Observations are derived from real client and ACC outcomes, never transcripts,
// paths, peer bodies, tokens, or credentials.

export const KIMI_WEB_PRODUCT_CASES = Object.freeze({
  C01: Object.freeze({ branch: "idle", requires: Object.freeze({ delivery: "woken",
    wake: "started-turn", projection: "body-shown", offer: "next-turn" }) }),
  C02: Object.freeze({ branch: "busy", requires: Object.freeze({ delivery: "queued",
    projection: "body-shown", offer: "next-turn" }) }),
  C03: Object.freeze({ branch: "reply", requires: Object.freeze({ answer: "recorded",
    receipt: "acknowledged" }) }),
  C04: Object.freeze({ branch: "duplicate", requires: Object.freeze({
    "logical-message": "same-message-id", wake: "delivered-once" }) }),
  C05: Object.freeze({ branch: "fallback", requires: Object.freeze({ client: "exited",
    delivery: "queued" }) }),
  C06: Object.freeze({ branch: "exact-binding", requires: Object.freeze({ delivery: "woken",
    wake: "started-turn", "other-session": "not-woken" }) }),
});

const RUN_FIELDS = ["schemaVersion", "source", "client", "phase", "clientVersion", "platform",
  "packageSha256", "startedAt", "finishedAt", "scenarioCount", "passedCount", "failedCount",
  "cleanup", "scenarios"];
const SCENARIO_FIELDS = ["caseId", "outcome", "startedAt", "finishedAt", "messageId", "observations"];
const OBSERVATION_FIELDS = ["kind", "at", "outcome"];
const CLEANUP_FIELDS = ["attempted", "outcome", "ownedProcesses", "temporaryState"];
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MESSAGE_ID = /^message_[A-Za-z0-9_-]{1,120}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}
function closed(value, fields, label) {
  expect(value && typeof value === "object" && !Array.isArray(value), `${label} is an object`);
  for (const key of Object.keys(value)) expect(fields.includes(key), `${label} has unknown field ${key}`);
  for (const key of fields) expect(Object.hasOwn(value, key), `${label} requires ${key}`);
}
const timestamp = value => typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));

export function scenarioPasses(caseId, observations) {
  const requires = KIMI_WEB_PRODUCT_CASES[caseId]?.requires;
  if (requires === undefined) return false;
  return Object.entries(requires).every(([kind, outcome]) =>
    observations.some(item => item.kind === kind && item.outcome === outcome));
}

export function assertKimiWebRunEvidence(value) {
  closed(value, RUN_FIELDS, "run");
  expect(value.schemaVersion === 1, "run schemaVersion is 1");
  expect(value.source === "real-client-capture", "run source is real-client-capture");
  expect(value.client === "kimi", "run client is kimi");
  expect(value.phase === "product", "run phase is product");
  expect(VERSION.test(value.clientVersion), "run clientVersion is exact semver");
  expect(value.platform === "darwin-arm64", "run platform is captured");
  expect(SHA256.test(value.packageSha256), "run packageSha256 is lowercase SHA-256");
  expect(timestamp(value.startedAt) && timestamp(value.finishedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt), "run timestamps are ordered");
  expect(Array.isArray(value.scenarios), "run scenarios is an array");
  for (const caseId of Object.keys(KIMI_WEB_PRODUCT_CASES)) {
    expect(value.scenarios.some(item => item?.caseId === caseId), `run requires case ${caseId}`);
  }
  expect(value.scenarios.length === Object.keys(KIMI_WEB_PRODUCT_CASES).length,
    "run has exactly one of every case");
  for (const scenario of value.scenarios) {
    closed(scenario, SCENARIO_FIELDS, "scenario");
    expect(Object.hasOwn(KIMI_WEB_PRODUCT_CASES, scenario.caseId), "scenario caseId is closed");
    expect(["passed", "failed"].includes(scenario.outcome), "scenario outcome is passed or failed");
    expect(MESSAGE_ID.test(scenario.messageId), "scenario messageId is an ACC message id");
    expect(timestamp(scenario.startedAt) && timestamp(scenario.finishedAt)
      && Date.parse(value.startedAt) <= Date.parse(scenario.startedAt)
      && Date.parse(scenario.finishedAt) <= Date.parse(value.finishedAt),
    "scenario timestamps are within run bounds");
    expect(Array.isArray(scenario.observations), "scenario observations is an array");
    for (const item of scenario.observations) {
      closed(item, OBSERVATION_FIELDS, "observation");
      expect(IDENTIFIER.test(item.kind) && IDENTIFIER.test(item.outcome) && timestamp(item.at),
        "observation is a closed kind, outcome and timestamp");
    }
    expect((scenario.outcome === "passed") === scenarioPasses(scenario.caseId, scenario.observations),
      `${scenario.caseId} outcome does not match its observations`);
  }
  const passed = value.scenarios.filter(item => item.outcome === "passed").length;
  expect(value.scenarioCount === value.scenarios.length && value.passedCount === passed
    && value.failedCount === value.scenarios.length - passed, "run scenario counts match");
  closed(value.cleanup, CLEANUP_FIELDS, "cleanup");
  expect(value.cleanup.attempted === true && ["passed", "failed"].includes(value.cleanup.outcome)
    && value.cleanup.ownedProcesses === "stopped" && value.cleanup.temporaryState === "removed",
  "cleanup stopped every owned process and removed temporary state");
  return structuredClone(value);
}
