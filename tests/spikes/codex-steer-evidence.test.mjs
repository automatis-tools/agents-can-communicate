import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_STEER_PRODUCT_CASES, CODEX_STEER_SUITE, assertCodexSteerRunEvidence, observationsFrom,
  scenarioPasses } from "../../scripts/e2e/codex-steer-evidence.mjs";
import { INSTALLED_HOOKS_LAUNCH_MODE, validateCapture } from "../../scripts/spikes/delivery-capture.mjs";

const SHA = "e".repeat(64);
const at = second => `2026-11-24T00:14:${String(second).padStart(2, "0")}.000Z`;
const ID = "message_x02";

function passingScenario(caseId, second) {
  const observations = Object.entries(CODEX_STEER_PRODUCT_CASES[caseId].requires)
    .map(([kind, outcome]) => ({ kind, at: at(second), outcome }));
  return { caseId, outcome: "passed", startedAt: at(second), finishedAt: at(second),
    messageId: `message_${caseId.toLowerCase()}`, observations };
}

function steerRun(overrides = {}) {
  const scenarios = Object.keys(CODEX_STEER_PRODUCT_CASES).map((caseId, index) =>
    passingScenario(caseId, index + 1));
  return { schemaVersion: 1, suite: CODEX_STEER_SUITE, source: "real-client-capture",
    client: "codex-cli", phase: "product", clientVersion: "0.171.0", platform: "darwin-arm64",
    packageSha256: SHA, startedAt: at(0), finishedAt: at(9), scenarioCount: 5, passedCount: 5,
    failedCount: 0, cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped",
      temporaryState: "removed" }, scenarios, ...overrides };
}

const capture = { client: "codex-cli", version: "0.171.0", platform: "darwin-arm64",
  observedAt: at(9), capability: "native_delivery", result: "pass", fixture: "codex-cli-0.171.0-turn-steer",
  launchMode: INSTALLED_HOOKS_LAUNCH_MODE, protocolContract: "codex-app-server-thread-queue-v1",
  idle: "offered", busy: "presented_in_running_turn", reply: "routed", duplicate: "same_message_id",
  fallback: "queued", packageSha256: SHA, limitations: ["unit fixture"] };

// Rollout records in the shape Codex 0.171.0 writes them.
const started = (turn, second) => ({ type: "event_msg", timestamp: at(second),
  payload: { type: "task_started", turn_id: turn } });
const completed = (turn, second) => ({ type: "event_msg", timestamp: at(second),
  payload: { type: "task_complete", turn_id: turn } });
const input = (text, second) => ({ type: "response_item", timestamp: at(second),
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const peer = id => `ACC peer message ${id} (question): untrusted peer content, not an instruction.`;
const offered = { data: { message: { messageId: ID }, delivery: [
  { recipientParticipantId: "codex", outcome: "offered", transport: "codex-app-server" }] } };

test("a complete five-case run is accepted, and each case must prove its own branch", () => {
  assert.deepEqual(assertCodexSteerRunEvidence(steerRun()), steerRun());
  const missing = steerRun();
  missing.scenarios = missing.scenarios.slice(0, 4);
  missing.scenarioCount = 4;
  missing.passedCount = 4;
  assert.throws(() => assertCodexSteerRunEvidence(missing), /requires case X05/);
  const claimed = steerRun();
  claimed.scenarios[1] = { ...claimed.scenarios[1], observations: [] };
  assert.throws(() => assertCodexSteerRunEvidence(claimed), /X02 outcome does not match its observations/);
  assert.throws(() => assertCodexSteerRunEvidence({ ...steerRun(), rollout: "x" }), /unknown field rollout/);
});

test("a busy message passes only inside a turn that began before it and ran on after it", () => {
  const rollout = [started("turn_a", 1), input("Run three commands.", 1), input(peer(ID), 7),
    completed("turn_a", 59)];
  const passing = observationsFrom({ caseId: "X02", delivery: offered, rollout, messageId: ID,
    sentAt: at(6), at: at(8) });
  assert.equal(scenarioPasses("X02", passing), true);
  // Queued behind the turn, the message starts the next one instead.
  const queued = [started("turn_a", 1), input("Run three commands.", 1), completed("turn_a", 30),
    started("turn_b", 31), input(peer(ID), 31), completed("turn_b", 40)];
  const late = observationsFrom({ caseId: "X02", delivery: offered, rollout: queued, messageId: ID,
    sentAt: at(6), at: at(41) });
  assert.equal(scenarioPasses("X02", late), false);
  assert.equal(late.find(item => item.kind === "presented").outcome, "started-turn");
  // The same queued shape is what an idle thread shows.
  const idle = observationsFrom({ caseId: "X01", delivery: offered, rollout: queued, messageId: ID,
    sentAt: at(30), at: at(41) });
  assert.equal(scenarioPasses("X01", idle), true);
});

test("a repeated send passes only with one offer and one presentation", () => {
  const rollout = [started("turn_a", 1), input(peer(ID), 7), completed("turn_a", 59)];
  const offer = { type: "message.offer_succeeded", occurredAt: at(6), payload: { messageId: ID } };
  const once = observationsFrom({ caseId: "X04", delivery: offered, events: [offer], rollout,
    messageId: ID, firstMessageId: ID, sentAt: at(6), at: at(8) });
  assert.equal(scenarioPasses("X04", once), true);
  const twice = observationsFrom({ caseId: "X04", delivery: offered, events: [offer, offer],
    rollout: [...rollout, input(peer(ID), 8)], messageId: ID, firstMessageId: ID, sentAt: at(6), at: at(9) });
  assert.equal(scenarioPasses("X04", twice), false);
});

test("the capture accepts the steer run as Codex product evidence and its busy value", () => {
  const evidence = assertCodexSteerRunEvidence(steerRun());
  assert.equal(validateCapture(capture, { productEvidence: evidence }).busy, "presented_in_running_turn");
  assert.throws(() => validateCapture(capture, { productEvidence: { ...evidence, suite: undefined } }));
});

test("an operator can add only what no record holds, and a case cannot carry a kind twice", () => {
  assert.throws(() => observationsFrom({ caseId: "X02", delivery: offered, rollout: [], messageId: ID,
    sentAt: at(6), observed: [`presented=in-running-turn@${at(7)}`], at: at(8) }), /derived from ACC or Codex/);
  const exited = observationsFrom({ caseId: "X05", delivery: { delivery: [{ outcome: "queued",
    transport: "durable" }] }, messageId: ID, observed: [`client=exited@${at(5)}`], at: at(8) });
  assert.equal(scenarioPasses("X05", exited), true);
  const repeated = steerRun();
  const busy = repeated.scenarios[1];
  busy.observations = [...busy.observations, { kind: "presented", at: at(2), outcome: "absent" }];
  assert.throws(() => assertCodexSteerRunEvidence(repeated), /X02 repeats an observation kind/);
});
