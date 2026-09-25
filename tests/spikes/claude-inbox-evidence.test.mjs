import assert from "node:assert/strict";
import test from "node:test";

import { CLAUDE_INBOX_PRODUCT_CASES, assertClaudeInboxRunEvidence, observationsFrom, scenarioPasses }
  from "../../scripts/e2e/claude-inbox-evidence.mjs";
import { INSTALLED_HOOKS_LAUNCH_MODE, validateCapture } from "../../scripts/spikes/delivery-capture.mjs";

const SHA = "e".repeat(64);
const at = minute => `2026-09-26T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ID = "message_c01";

function passingScenario(caseId, minute) {
  const observations = Object.entries(CLAUDE_INBOX_PRODUCT_CASES[caseId].requires)
    .map(([kind, outcome]) => ({ kind, at: at(minute), outcome }));
  return { caseId, outcome: "passed", startedAt: at(minute), finishedAt: at(minute),
    messageId: `message_${caseId.toLowerCase()}`, observations };
}

function claudeRun(overrides = {}) {
  const scenarios = Object.keys(CLAUDE_INBOX_PRODUCT_CASES).map((caseId, index) =>
    passingScenario(caseId, index + 1));
  return { schemaVersion: 1, source: "real-client-capture", client: "claude-code",
    phase: "product", clientVersion: "2.1.282", platform: "darwin-arm64", packageSha256: SHA,
    startedAt: at(0), finishedAt: at(9), scenarioCount: 6, passedCount: 6, failedCount: 0,
    cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" },
    scenarios, ...overrides };
}

const capture = { client: "claude-code", version: "2.1.282", platform: "darwin-arm64",
  observedAt: at(9), capability: "native_delivery", result: "pass",
  fixture: "claude-code-2.1.282", launchMode: INSTALLED_HOOKS_LAUNCH_MODE,
  protocolContract: "claude-code-inbox-socket-v1", idle: "offered",
  busy: "presented_between_tool_calls", reply: "routed", duplicate: "same_message_id",
  fallback: "queued", packageSha256: SHA, limitations: ["unit fixture"] };

// Transcript records in the shape Claude Code 2.1.282 writes them.
const wakeText = id => `Another Claude session sent a message:\nACC: new peer message ${id} for this session. `;
const idleWake = id => ({ type: "user", timestamp: at(1), origin: { kind: "peer", from: "unknown" },
  message: { role: "user", content: wakeText(id) } });
const busyWake = id => ({ type: "attachment", timestamp: at(1), attachment: { type: "queued_command",
  prompt: `ACC: new peer message ${id} for this session. `, origin: { kind: "peer" } } });
const projection = id => ({ type: "attachment", timestamp: at(2), attachment: {
  type: "hook_additional_context", hookEvent: "UserPromptSubmit",
  content: [`\`\`\`acc-peer-message\nuntrusted peer message\nmessageId: ${id}\n`] } });
const woken = { data: { message: { messageId: ID }, delivery: [
  { recipientParticipantId: "claude", outcome: "woken", transport: "claude-inbox" }] } };
const offered = id => ({ type: "message.offer_succeeded", occurredAt: at(2),
  payload: { messageId: id, transport: "next-turn" } });

test("a complete six-case run is accepted, and each case must prove its own branch", () => {
  assert.deepEqual(assertClaudeInboxRunEvidence(claudeRun()), claudeRun());
  const missing = claudeRun();
  missing.scenarios = missing.scenarios.slice(0, 5);
  missing.scenarioCount = 5;
  missing.passedCount = 5;
  assert.throws(() => assertClaudeInboxRunEvidence(missing), /requires case C06/);
  const claimed = claudeRun();
  claimed.scenarios[0] = { ...claimed.scenarios[0], observations: [] };
  assert.throws(() => assertClaudeInboxRunEvidence(claimed), /C01 outcome does not match its observations/);
});

test("the run refuses fields it does not know, and bodies have nowhere to go", () => {
  assert.throws(() => assertClaudeInboxRunEvidence({ ...claudeRun(), transcript: "x" }), /unknown field transcript/);
  const withBody = claudeRun();
  withBody.scenarios[0] = { ...withBody.scenarios[0], body: "peer text" };
  assert.throws(() => assertClaudeInboxRunEvidence(withBody), /unknown field body/);
});

test("an idle wake passes only when the wake started a turn and the hook showed the body", () => {
  const passing = observationsFrom({ caseId: "C01", delivery: woken, events: [offered(ID)],
    transcript: [idleWake(ID), projection(ID)], messageId: ID, at: at(3) });
  assert.equal(scenarioPasses("C01", passing), true);
  const unshown = observationsFrom({ caseId: "C01", delivery: woken, events: [offered(ID)],
    transcript: [idleWake(ID)], messageId: ID, at: at(3) });
  assert.equal(scenarioPasses("C01", unshown), false, "a wake with no projected body is not delivery");
  const durable = { delivery: [{ recipientParticipantId: "claude", outcome: "queued", transport: "durable" }] };
  assert.equal(scenarioPasses("C01", observationsFrom({ caseId: "C01", delivery: durable,
    events: [offered(ID)], transcript: [idleWake(ID), projection(ID)], messageId: ID, at: at(3) })), false);
  const live = { ...offered(ID), payload: { messageId: ID, transport: "claude-inbox" } };
  assert.equal(scenarioPasses("C01", observationsFrom({ caseId: "C01", delivery: woken, events: [live],
    transcript: [idleWake(ID), projection(ID)], messageId: ID, at: at(3) })), false,
  "a wake recorded as an offer would hide the body");
});

test("a busy wake passes only when Claude took it between two tool calls", () => {
  const observations = observationsFrom({ caseId: "C02", delivery: woken, events: [offered(ID)],
    transcript: [busyWake(ID), projection(ID)], messageId: ID, at: at(3) });
  assert.equal(scenarioPasses("C02", observations), true);
  assert.equal(scenarioPasses("C02", observationsFrom({ caseId: "C02", delivery: woken,
    events: [offered(ID)], transcript: [idleWake(ID), projection(ID)], messageId: ID, at: at(3) })), false);
});

test("reply, duplicate, fallback and exact binding read ACC's own records", () => {
  const reply = observationsFrom({ caseId: "C03", messageId: ID, at: at(3), events: [
    { type: "message.recorded", occurredAt: at(2), payload: { messageId: "message_answer", threadId: ID } },
    { type: "message.acknowledged", occurredAt: at(2), payload: { messageId: ID } }] });
  assert.equal(scenarioPasses("C03", reply), true);
  const duplicate = observationsFrom({ caseId: "C04", delivery: woken, firstMessageId: ID,
    transcript: [idleWake(ID)], messageId: ID, at: at(3) });
  assert.equal(scenarioPasses("C04", duplicate), true);
  assert.equal(scenarioPasses("C04", observationsFrom({ caseId: "C04", delivery: woken, firstMessageId: ID,
    transcript: [idleWake(ID), idleWake(ID)], messageId: ID, at: at(3) })), false, "two wakes for one message");
  const queued = { delivery: [{ recipientParticipantId: "claude", outcome: "queued", transport: "durable" }] };
  assert.equal(scenarioPasses("C05", observationsFrom({ caseId: "C05", delivery: queued, messageId: ID,
    observed: [`client=exited@${at(2)}`], at: at(3) })), true);
  const exact = observationsFrom({ caseId: "C06", delivery: woken, transcript: [idleWake(ID)],
    otherTranscript: [], messageId: ID, at: at(3) });
  assert.equal(scenarioPasses("C06", exact), true);
  assert.equal(scenarioPasses("C06", observationsFrom({ caseId: "C06", delivery: woken,
    transcript: [idleWake(ID)], otherTranscript: [idleWake(ID)], messageId: ID, at: at(3) })), false,
  "a wake that also reached the other session is not an exact binding");
});

test("an installed-hook Claude pass needs its own product evidence", () => {
  assert.doesNotThrow(() => validateCapture(capture, { productEvidence: claudeRun() }));
  assert.throws(() => validateCapture(capture), /installed-hook pass requires product evidence/);
  assert.throws(() => validateCapture({ ...capture, packageSha256: "d".repeat(64) },
    { productEvidence: claudeRun() }), /package SHA-256 matches product evidence/);
});
