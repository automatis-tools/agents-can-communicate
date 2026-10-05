// Closed evidence for live delivery into Antigravity 2.0, the desktop app,
// captured through an installed candidate and the real app.
//
// Six cases, one message each. Every observation is a closed value read from
// ACC's own JSON results and the conversation's transcript, or observed on the
// screen - never a body, a prompt, a path or a credential. A case passes only
// when every observation its branch requires carries the passing value.

export const DESKTOP_PRODUCT_CASES = Object.freeze({
  // An idle conversation wakes with nobody typing.
  D01: Object.freeze({ branch: "idle", requires: Object.freeze({ delivery: "offered",
    "desktop-push": "pushed", "model-turn": "started-without-user-input" }) }),
  // A push during a running answer is shown after it, the answer uninterrupted.
  D02: Object.freeze({ branch: "busy", requires: Object.freeze({ delivery: "offered",
    "desktop-push": "pushed", presentation: "after-running-turn" }) }),
  // The woken agent answers, and nobody has to approve its ACC command.
  D03: Object.freeze({ branch: "reply", requires: Object.freeze({ answer: "recorded",
    receipt: "acknowledged", approval: "not-asked" }) }),
  // A resent logical message keeps its id and reaches the model once.
  D04: Object.freeze({ branch: "duplicate", requires: Object.freeze({
    "logical-message": "same-message-id", "desktop-push": "pushed-once" }) }),
  // With the app quit, the message waits in the inbox.
  D05: Object.freeze({ branch: "fallback", requires: Object.freeze({ client: "exited",
    delivery: "queued" }) }),
  // After the app restarts - a new token and port - the next turn binds again.
  D06: Object.freeze({ branch: "restart", requires: Object.freeze({ client: "restarted",
    delivery: "offered", "desktop-push": "pushed" }) }),
});

const RUN_FIELDS = ["schemaVersion", "source", "client", "phase", "clientVersion", "platform",
  "packageSha256", "startedAt", "finishedAt", "scenarioCount", "passedCount", "failedCount",
  "cleanup", "scenarios"];
const SCENARIO_FIELDS = ["caseId", "outcome", "startedAt", "finishedAt", "messageId", "observations"];
const OBSERVATION_FIELDS = ["kind", "at", "outcome"];
const CLEANUP_FIELDS = ["attempted", "outcome", "ownedProcesses", "temporaryState"];
const LIVE_TRANSPORTS = Object.freeze(["live-adapter", "antigravity-desktop"]);
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
  const requires = DESKTOP_PRODUCT_CASES[caseId]?.requires;
  if (requires === undefined) return false;
  return Object.entries(requires).every(([kind, outcome]) =>
    observations.some(item => item.kind === kind && item.outcome === outcome));
}

export function assertAntigravityDesktopRunEvidence(value) {
  closed(value, RUN_FIELDS, "run");
  expect(value.schemaVersion === 1, "run schemaVersion is 1");
  expect(value.source === "real-client-capture", "run source is real-client-capture");
  expect(value.client === "antigravity-desktop", "run client is antigravity-desktop");
  expect(value.phase === "product", "run phase is product");
  expect(VERSION.test(value.clientVersion), "run clientVersion is exact semver");
  expect(value.platform === "darwin-arm64", "run platform is captured");
  expect(SHA256.test(value.packageSha256), "run packageSha256 is lowercase SHA-256");
  expect(timestamp(value.startedAt) && timestamp(value.finishedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt), "run timestamps are ordered");
  expect(Array.isArray(value.scenarios), "run scenarios is an array");
  for (const caseId of Object.keys(DESKTOP_PRODUCT_CASES)) {
    expect(value.scenarios.some(item => item?.caseId === caseId), `run requires case ${caseId}`);
  }
  expect(value.scenarios.length === Object.keys(DESKTOP_PRODUCT_CASES).length,
    "run has exactly one of every case");
  for (const scenario of value.scenarios) {
    closed(scenario, SCENARIO_FIELDS, "scenario");
    expect(Object.hasOwn(DESKTOP_PRODUCT_CASES, scenario.caseId), "scenario caseId is closed");
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

// The conversation's transcript steps, one JSON object per line, as the app
// writes them under ~/.gemini/antigravity/brain/<conversation>/.
const stepsOf = transcript => String(transcript).split("\n").filter(Boolean).map(line => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

/**
 * What a case showed, derived wherever ACC or the app recorded it: the delivery
 * outcome from `acc message --json`, pushes and the turn that followed from
 * the transcript. Only what neither records - the order on screen, an approval
 * prompt, the app quitting - is taken from the operator, as `kind=outcome@<iso>`.
 */
export function observationsFrom({ caseId, delivery, transcript = "", messageId, observed = [], at }) {
  const observations = [];
  const entry = (delivery?.data ?? delivery)?.delivery?.find(item => item.outcome !== undefined);
  if (entry !== undefined && ["D01", "D02", "D05", "D06"].includes(caseId)) {
    observations.push({ kind: "delivery", at,
      outcome: entry.outcome === "offered" && LIVE_TRANSPORTS.includes(entry.transport) ? "offered"
        : entry.outcome === "queued" ? "queued" : "other" });
  }
  const steps = stepsOf(transcript);
  const pushed = steps.filter(step => step.type === "SYSTEM_MESSAGE"
    && String(step.content ?? "").includes(`ACC peer message ${messageId} `));
  const pushAt = step => (timestamp(step?.created_at) ? step.created_at : at);
  if (["D01", "D02", "D06"].includes(caseId)) {
    observations.push({ kind: "desktop-push", at: pushAt(pushed[0]),
      outcome: pushed.length === 1 ? "pushed" : pushed.length === 0 ? "not-pushed" : "pushed-twice" });
  }
  if (caseId === "D04") {
    observations.push({ kind: "desktop-push", at: pushAt(pushed.at(-1)),
      outcome: pushed.length === 1 ? "pushed-once" : pushed.length === 0 ? "not-pushed" : "pushed-twice" });
  }
  if (caseId === "D01" && pushed.length > 0) {
    const index = steps.indexOf(pushed[0]);
    const after = steps.slice(index + 1);
    const model = after.findIndex(step => step.source === "MODEL");
    const user = after.findIndex(step => step.type === "USER_INPUT");
    observations.push({ kind: "model-turn", at: pushAt(after[model]),
      outcome: model >= 0 && (user === -1 || model < user) ? "started-without-user-input"
        : "not-started" });
  }
  for (const item of observed) {
    const match = /^([a-z][a-z0-9-]*)=([a-z][a-z0-9-]*)@(.+)$/.exec(item);
    if (match === null) throw new Error(`observation ${item} is not kind=outcome@<iso>`);
    observations.push({ kind: match[1], outcome: match[2], at: match[3] });
  }
  return observations;
}
