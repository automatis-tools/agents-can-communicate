// Closed evidence for the Antigravity relay's installed-product capture.
//
// Five cases, one message each, through an installed candidate and a real
// Antigravity CLI TUI. Every observation is a closed value read from ACC's own
// JSON results and the relay's event log, or observed by the operator on the
// screen - never a body, a prompt, a path or a credential. A case passes only
// when every observation its branch requires carries the passing value.

export const ANTIGRAVITY_PRODUCT_CASES = Object.freeze({
  A01: Object.freeze({ branch: "idle", requires: Object.freeze({ delivery: "offered",
    "relay-push": "pushed", "model-turn": "started-without-user-input" }) }),
  A02: Object.freeze({ branch: "busy", requires: Object.freeze({ delivery: "offered",
    "relay-push": "pushed", presentation: "after-running-turn" }) }),
  A03: Object.freeze({ branch: "reply", requires: Object.freeze({ answer: "recorded",
    receipt: "acknowledged" }) }),
  A04: Object.freeze({ branch: "duplicate", requires: Object.freeze({
    "logical-message": "same-message-id", "relay-push": "pushed-once" }) }),
  A05: Object.freeze({ branch: "fallback", requires: Object.freeze({ client: "exited",
    relay: "retired", delivery: "queued" }) }),
});

const RUN_FIELDS = ["schemaVersion", "source", "client", "phase", "clientVersion", "platform",
  "packageSha256", "startedAt", "finishedAt", "scenarioCount", "passedCount", "failedCount",
  "cleanup", "scenarios"];
const SCENARIO_FIELDS = ["caseId", "outcome", "startedAt", "finishedAt", "messageId", "observations"];
const OBSERVATION_FIELDS = ["kind", "at", "outcome"];
const CLEANUP_FIELDS = ["attempted", "outcome", "ownedProcesses", "temporaryState"];
const LIVE_TRANSPORTS = Object.freeze(["live-adapter", "antigravity-relay"]);
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
  const requires = ANTIGRAVITY_PRODUCT_CASES[caseId]?.requires;
  if (requires === undefined) return false;
  return Object.entries(requires).every(([kind, outcome]) =>
    observations.some(item => item.kind === kind && item.outcome === outcome));
}

export function assertAntigravityRunEvidence(value) {
  closed(value, RUN_FIELDS, "run");
  expect(value.schemaVersion === 1, "run schemaVersion is 1");
  expect(value.source === "real-client-capture", "run source is real-client-capture");
  expect(value.client === "antigravity-cli", "run client is antigravity-cli");
  expect(value.phase === "product", "run phase is product");
  expect(VERSION.test(value.clientVersion), "run clientVersion is exact semver");
  expect(value.platform === "darwin-arm64", "run platform is captured");
  expect(SHA256.test(value.packageSha256), "run packageSha256 is lowercase SHA-256");
  expect(timestamp(value.startedAt) && timestamp(value.finishedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt), "run timestamps are ordered");
  expect(Array.isArray(value.scenarios), "run scenarios is an array");
  for (const caseId of Object.keys(ANTIGRAVITY_PRODUCT_CASES)) {
    expect(value.scenarios.some(item => item?.caseId === caseId), `run requires case ${caseId}`);
  }
  expect(value.scenarios.length === Object.keys(ANTIGRAVITY_PRODUCT_CASES).length,
    "run has exactly one of every case");
  for (const scenario of value.scenarios) {
    closed(scenario, SCENARIO_FIELDS, "scenario");
    expect(Object.hasOwn(ANTIGRAVITY_PRODUCT_CASES, scenario.caseId), "scenario caseId is closed");
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

/**
 * What a case showed, derived rather than typed in wherever ACC recorded it:
 * the delivery outcome from `acc message --json`, pushes from the relay log.
 * Only what ACC cannot see - the model starting a turn by itself, or the order
 * on screen - is taken from the operator, as `kind=outcome@<iso>`.
 */
export function observationsFrom({ caseId, delivery, relayLog = "", messageId, observed = [], at }) {
  const observations = [];
  const entry = (delivery?.data ?? delivery)?.delivery?.find(item => item.outcome !== undefined);
  if (entry !== undefined && ["A01", "A02", "A05"].includes(caseId)) {
    observations.push({ kind: "delivery", at,
      // The router names a native adapter push "live-adapter" unless the
      // transport is one of its named ones; a durable offer is never a wake.
      outcome: entry.outcome === "offered" && LIVE_TRANSPORTS.includes(entry.transport) ? "offered"
        : entry.outcome === "queued" ? "queued" : "other" });
  }
  const events = String(relayLog).split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const pushes = events.filter(item => item.event === "pushed" && item.messageId === messageId);
  if (["A01", "A02"].includes(caseId)) {
    observations.push({ kind: "relay-push", at: pushes[0]?.at ?? at,
      outcome: pushes.length === 1 ? "pushed" : pushes.length === 0 ? "not-pushed" : "pushed-twice" });
  }
  if (caseId === "A04") {
    observations.push({ kind: "relay-push", at: pushes.at(-1)?.at ?? at,
      outcome: pushes.length === 1 ? "pushed-once" : pushes.length === 0 ? "not-pushed" : "pushed-twice" });
  }
  if (caseId === "A05") {
    const closedEvent = events.find(item => item.event === "relay_closed");
    observations.push({ kind: "relay", at: closedEvent?.at ?? at,
      outcome: closedEvent?.reasonCode === "client_exited" ? "retired" : "still-running" });
  }
  for (const item of observed) {
    const match = /^([a-z][a-z0-9-]*)=([a-z][a-z0-9-]*)@(.+)$/.exec(item);
    if (match === null) throw new Error(`observation ${item} is not kind=outcome@<iso>`);
    observations.push({ kind: match[1], outcome: match[2], at: match[3] });
  }
  return observations;
}
