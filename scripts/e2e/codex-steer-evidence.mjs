// Closed evidence for Codex live delivery into a running turn (#132).
//
// Five cases, one ACC message each, through an installed candidate and a real
// Codex TUI on its app-server daemon. Every observation is a closed value derived
// from ACC's own JSON results and events, or from the receiving thread's own
// rollout records - never a body, a prompt, a path or a credential. A case
// passes only when every observation its branch requires carries the passing
// value. Capture scaffolding: never shipped, never imported by product code.
//
// The 0.152.1 and 0.153.4 captures, when Codex queued a busy session's message
// until its turn ended, are the twenty-case matrix in codex-local-daemon-evidence.mjs.

export const CODEX_STEER_SUITE = "codex-turn-steer";

export const CODEX_STEER_PRODUCT_CASES = Object.freeze({
  X01: Object.freeze({ branch: "idle", requires: Object.freeze({ delivery: "offered",
    presented: "started-turn" }) }),
  X02: Object.freeze({ branch: "busy", requires: Object.freeze({ delivery: "offered",
    presented: "in-running-turn" }) }),
  X03: Object.freeze({ branch: "reply", requires: Object.freeze({ answer: "recorded",
    receipt: "acknowledged" }) }),
  X04: Object.freeze({ branch: "duplicate", requires: Object.freeze({
    "logical-message": "same-message-id", offer: "once", presented: "once" }) }),
  X05: Object.freeze({ branch: "fallback", requires: Object.freeze({ client: "exited",
    delivery: "queued" }) }),
});

const RUN_FIELDS = ["schemaVersion", "suite", "source", "client", "phase", "clientVersion",
  "platform", "packageSha256", "startedAt", "finishedAt", "scenarioCount", "passedCount",
  "failedCount", "cleanup", "scenarios"];
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
  const requires = CODEX_STEER_PRODUCT_CASES[caseId]?.requires;
  if (requires === undefined) return false;
  return Object.entries(requires).every(([kind, outcome]) =>
    observations.some(item => item.kind === kind && item.outcome === outcome));
}

export function assertCodexSteerRunEvidence(value) {
  closed(value, RUN_FIELDS, "run");
  expect(value.schemaVersion === 1, "run schemaVersion is 1");
  expect(value.suite === CODEX_STEER_SUITE, `run suite is ${CODEX_STEER_SUITE}`);
  expect(value.source === "real-client-capture", "run source is real-client-capture");
  expect(value.client === "codex-cli", "run client is codex-cli");
  expect(value.phase === "product", "run phase is product");
  expect(VERSION.test(value.clientVersion), "run clientVersion is exact semver");
  expect(value.platform === "darwin-arm64", "run platform is captured");
  expect(SHA256.test(value.packageSha256), "run packageSha256 is lowercase SHA-256");
  expect(timestamp(value.startedAt) && timestamp(value.finishedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt), "run timestamps are ordered");
  expect(Array.isArray(value.scenarios), "run scenarios is an array");
  for (const caseId of Object.keys(CODEX_STEER_PRODUCT_CASES)) {
    expect(value.scenarios.some(item => item?.caseId === caseId), `run requires case ${caseId}`);
  }
  expect(value.scenarios.length === Object.keys(CODEX_STEER_PRODUCT_CASES).length,
    "run has exactly one of every case");
  for (const scenario of value.scenarios) {
    closed(scenario, SCENARIO_FIELDS, "scenario");
    expect(Object.hasOwn(CODEX_STEER_PRODUCT_CASES, scenario.caseId), "scenario caseId is closed");
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

const text = value => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

// The rollout's turns: when each started and completed, and the user inputs it took.
function turnsIn(rollout) {
  const turns = [];
  for (const record of rollout) {
    const payload = record?.payload ?? {};
    if (record?.type === "event_msg" && payload.type === "task_started") {
      turns.push({ id: payload.turn_id, startedAt: record.timestamp, completedAt: null, inputs: [] });
    } else if (record?.type === "event_msg" && payload.type === "task_complete") {
      const turn = turns.findLast(item => item.id === payload.turn_id);
      if (turn) turn.completedAt = record.timestamp;
    } else if (record?.type === "response_item" && payload.type === "message" && payload.role === "user") {
      turns.at(-1)?.inputs.push({ at: record.timestamp, text: text(payload.content) });
    }
  }
  return turns;
}

// Where the receiving thread took a message: as the input that started a turn,
// or as input added to a turn that was already running and went on after it.
function presentations(rollout, messageId, sentAt) {
  const header = `ACC peer message ${messageId} `;
  return turnsIn(rollout).flatMap(turn => turn.inputs.filter(input => input.text.includes(header))
    .map(input => ({ at: input.at, mode: turn.inputs[0] === input && turn.startedAt >= sentAt
      ? "started-turn"
      : turn.startedAt < sentAt && turn.completedAt !== null && turn.completedAt > input.at
        ? "in-running-turn" : "other" })));
}

/**
 * What a case showed, derived rather than typed in wherever ACC or Codex
 * recorded it: the delivery outcome from `acc message --json`, offers and
 * answers from `acc sync --scope full --json` events, presentations from the
 * receiving thread's rollout. Only what neither records - that the client's
 * service stopped - is taken from the operator, as `kind=outcome@<iso>`.
 */
export function observationsFrom({ caseId, delivery, events = [], rollout = [], messageId,
  firstMessageId = null, sentAt, observed = [], at }) {
  const observations = [];
  const data = delivery?.data ?? delivery;
  const entry = data?.delivery?.find(item => item.outcome !== undefined);
  if (entry !== undefined && ["X01", "X02", "X05"].includes(caseId)) {
    observations.push({ kind: "delivery", at, outcome: entry.outcome === "offered"
      && entry.transport === "codex-app-server" ? "offered" : entry.outcome === "queued" ? "queued" : "other" });
  }
  const shown = presentations(rollout, messageId, sentAt ?? at);
  if (["X01", "X02"].includes(caseId)) {
    observations.push({ kind: "presented", at: shown[0]?.at ?? at,
      outcome: shown.length === 1 ? shown[0].mode : shown.length === 0 ? "absent" : "repeated" });
  }
  if (caseId === "X03") {
    const answer = events.find(event => event.type === "message.recorded"
      && event.payload?.threadId === messageId && event.payload?.messageId !== messageId);
    observations.push({ kind: "answer", at: answer?.occurredAt ?? at, outcome: answer ? "recorded" : "absent" });
    const acknowledged = events.find(event => event.type === "message.acknowledged"
      && event.payload?.messageId === messageId);
    observations.push({ kind: "receipt", at: acknowledged?.occurredAt ?? at,
      outcome: acknowledged ? "acknowledged" : "open" });
  }
  if (caseId === "X04") {
    observations.push({ kind: "logical-message", at,
      outcome: firstMessageId !== null && data?.message?.messageId === firstMessageId
        ? "same-message-id" : "new-message" });
    const offers = events.filter(event => event.type === "message.offer_succeeded"
      && event.payload?.messageId === messageId);
    observations.push({ kind: "offer", at: offers.at(-1)?.occurredAt ?? at,
      outcome: offers.length === 1 ? "once" : offers.length === 0 ? "absent" : "repeated" });
    observations.push({ kind: "presented", at: shown.at(-1)?.at ?? at,
      outcome: shown.length === 1 ? "once" : shown.length === 0 ? "absent" : "repeated" });
  }
  for (const item of observed) {
    const match = /^([a-z][a-z0-9-]*)=([a-z][a-z0-9-]*)@(.+)$/.exec(item);
    if (match === null) throw new Error(`observation ${item} is not kind=outcome@<iso>`);
    observations.push({ kind: match[1], outcome: match[2], at: match[3] });
  }
  return observations;
}
