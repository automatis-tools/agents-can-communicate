// Closed evidence for the Claude Code inbox wake's installed-product capture.
//
// Six cases, one ACC message each, through an installed candidate and real
// Claude Code TUI sessions. Every observation is a closed value derived from
// ACC's own JSON results and events, or from the receiving session's own
// transcript records - never a body, a prompt, a path or a credential. A case
// passes only when every observation its branch requires carries the passing
// value. Capture scaffolding: never shipped, never imported by product code.

export const CLAUDE_INBOX_PRODUCT_CASES = Object.freeze({
  C01: Object.freeze({ branch: "idle", requires: Object.freeze({ delivery: "woken",
    wake: "started-turn", projection: "body-shown", offer: "next-turn" }) }),
  C02: Object.freeze({ branch: "busy", requires: Object.freeze({ delivery: "woken",
    wake: "between-tool-calls", projection: "body-shown", offer: "next-turn" }) }),
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
  const requires = CLAUDE_INBOX_PRODUCT_CASES[caseId]?.requires;
  if (requires === undefined) return false;
  return Object.entries(requires).every(([kind, outcome]) =>
    observations.some(item => item.kind === kind && item.outcome === outcome));
}

export function assertClaudeInboxRunEvidence(value) {
  closed(value, RUN_FIELDS, "run");
  expect(value.schemaVersion === 1, "run schemaVersion is 1");
  expect(value.source === "real-client-capture", "run source is real-client-capture");
  expect(value.client === "claude-code", "run client is claude-code");
  expect(value.phase === "product", "run phase is product");
  expect(VERSION.test(value.clientVersion), "run clientVersion is exact semver");
  expect(value.platform === "darwin-arm64", "run platform is captured");
  expect(SHA256.test(value.packageSha256), "run packageSha256 is lowercase SHA-256");
  expect(timestamp(value.startedAt) && timestamp(value.finishedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt), "run timestamps are ordered");
  expect(Array.isArray(value.scenarios), "run scenarios is an array");
  for (const caseId of Object.keys(CLAUDE_INBOX_PRODUCT_CASES)) {
    expect(value.scenarios.some(item => item?.caseId === caseId), `run requires case ${caseId}`);
  }
  expect(value.scenarios.length === Object.keys(CLAUDE_INBOX_PRODUCT_CASES).length,
    "run has exactly one of every case");
  for (const scenario of value.scenarios) {
    closed(scenario, SCENARIO_FIELDS, "scenario");
    expect(Object.hasOwn(CLAUDE_INBOX_PRODUCT_CASES, scenario.caseId), "scenario caseId is closed");
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

// The receiving session's own records of a wake: a peer turn it started while
// idle, or a queued command it took in between two tool calls.
function wakesIn(records, messageId) {
  const marker = `acc-wake-${messageId}`;
  const wakeText = `new peer message ${messageId} `;
  return records.filter(record => {
    if (record?.type === "user" && record.origin?.kind === "peer") {
      return text(record.message?.content).includes(wakeText);
    }
    const attachment = record?.attachment;
    return record?.type === "attachment" && attachment?.type === "queued_command"
      && attachment.origin?.kind === "peer"
      && (text(attachment.prompt).includes(wakeText) || text(attachment).includes(marker));
  }).map(record => ({ at: record.timestamp ?? record.attachment?.timestamp,
    mode: record.type === "user" ? "started-turn" : "between-tool-calls" }));
}

function projectedIn(records, messageId) {
  return records.find(record => record?.type === "attachment"
    && record.attachment?.type === "hook_additional_context"
    && record.attachment?.hookEvent === "UserPromptSubmit"
    && text(record.attachment.content).includes(`messageId: ${messageId}`));
}

/**
 * What a case showed, derived rather than typed in wherever ACC or Claude
 * recorded it: the delivery outcome from `acc message --json`, offers and
 * answers from `acc sync --scope full --json` events, wakes and projections
 * from the receiving session's transcript. Only what neither records - that a
 * client process exited - is taken from the operator, as `kind=outcome@<iso>`.
 */
export function observationsFrom({ caseId, delivery, events = [], transcript = [],
  otherTranscript = null, messageId, firstMessageId = null, observed = [], at }) {
  const observations = [];
  const data = delivery?.data ?? delivery;
  const entry = data?.delivery?.find(item => item.outcome !== undefined);
  if (entry !== undefined && ["C01", "C02", "C05", "C06"].includes(caseId)) {
    observations.push({ kind: "delivery", at, outcome: entry.outcome === "woken"
      && entry.transport === "claude-inbox" ? "woken" : entry.outcome === "queued" ? "queued" : "other" });
  }
  const wakes = wakesIn(transcript, messageId);
  if (["C01", "C02", "C06"].includes(caseId)) {
    observations.push({ kind: "wake", at: wakes[0]?.at ?? at,
      outcome: wakes.length === 1 ? wakes[0].mode : wakes.length === 0 ? "absent" : "repeated" });
  }
  if (["C01", "C02"].includes(caseId)) {
    const projected = projectedIn(transcript, messageId);
    observations.push({ kind: "projection", at: projected?.timestamp ?? at,
      outcome: projected === undefined ? "absent" : "body-shown" });
    const offer = events.find(event => event.type === "message.offer_succeeded"
      && event.payload?.messageId === messageId);
    observations.push({ kind: "offer", at: offer?.occurredAt ?? at,
      outcome: offer?.payload?.transport === "next-turn" ? "next-turn"
        : offer === undefined ? "absent" : "live" });
  }
  if (caseId === "C03") {
    const answer = events.find(event => event.type === "message.recorded"
      && event.payload?.threadId === messageId && event.payload?.messageId !== messageId);
    observations.push({ kind: "answer", at: answer?.occurredAt ?? at, outcome: answer ? "recorded" : "absent" });
    const acknowledged = events.find(event => event.type === "message.acknowledged"
      && event.payload?.messageId === messageId);
    observations.push({ kind: "receipt", at: acknowledged?.occurredAt ?? at,
      outcome: acknowledged ? "acknowledged" : "open" });
  }
  if (caseId === "C04") {
    observations.push({ kind: "logical-message", at,
      outcome: firstMessageId !== null && data?.message?.messageId === firstMessageId
        ? "same-message-id" : "new-message" });
    observations.push({ kind: "wake", at: wakes.at(-1)?.at ?? at,
      outcome: wakes.length === 1 ? "delivered-once" : wakes.length === 0 ? "absent" : "repeated" });
  }
  if (caseId === "C06" && otherTranscript !== null) {
    observations.push({ kind: "other-session", at,
      outcome: wakesIn(otherTranscript, messageId).length === 0 ? "not-woken" : "woken" });
  }
  for (const item of observed) {
    const match = /^([a-z][a-z0-9-]*)=([a-z][a-z0-9-]*)@(.+)$/.exec(item);
    if (match === null) throw new Error(`observation ${item} is not kind=outcome@<iso>`);
    observations.push({ kind: match[1], outcome: match[2], at: match[3] });
  }
  return observations;
}
