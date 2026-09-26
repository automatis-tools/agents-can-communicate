import assert from "node:assert/strict";
import test from "node:test";

import { ANTIGRAVITY_PRODUCT_CASES, assertAntigravityRunEvidence, observationsFrom, scenarioPasses }
  from "../../scripts/e2e/antigravity-relay-evidence.mjs";
import { INSTALLED_HOOKS_LAUNCH_MODE, validateCapture } from "../../scripts/spikes/delivery-capture.mjs";

const SHA = "c".repeat(64);
const at = minute => `2026-09-22T10:${String(minute).padStart(2, "0")}:00.000Z`;

function passingScenario(caseId, minute) {
  const observations = Object.entries(ANTIGRAVITY_PRODUCT_CASES[caseId].requires)
    .map(([kind, outcome]) => ({ kind, at: at(minute), outcome }));
  return { caseId, outcome: "passed", startedAt: at(minute), finishedAt: at(minute),
    messageId: `message_${caseId.toLowerCase()}`, observations };
}

function antigravityRun(overrides = {}) {
  const scenarios = Object.keys(ANTIGRAVITY_PRODUCT_CASES).map((caseId, index) =>
    passingScenario(caseId, index + 1));
  return { schemaVersion: 1, source: "real-client-capture", client: "antigravity-cli",
    phase: "product", clientVersion: "1.2.7", platform: "darwin-arm64", packageSha256: SHA,
    startedAt: at(0), finishedAt: at(9), scenarioCount: 5, passedCount: 5, failedCount: 0,
    cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" },
    scenarios, ...overrides };
}

const capture = { client: "antigravity-cli", version: "1.2.7", platform: "darwin-arm64",
  observedAt: at(9), capability: "native_delivery", result: "pass",
  fixture: "antigravity-cli-1.2.7-relay-product", launchMode: INSTALLED_HOOKS_LAUNCH_MODE,
  protocolContract: "antigravity-agentapi-relay-v1", idle: "offered", busy: "queued_after_turn",
  reply: "routed", duplicate: "same_message_id", fallback: "queued", packageSha256: SHA,
  limitations: ["unit fixture"] };

test("a complete five-case run is accepted, and each case must prove its own branch", () => {
  assert.deepEqual(assertAntigravityRunEvidence(antigravityRun()), antigravityRun());
  const missing = antigravityRun();
  missing.scenarios = missing.scenarios.slice(0, 4);
  missing.scenarioCount = 4;
  missing.passedCount = 4;
  assert.throws(() => assertAntigravityRunEvidence(missing), /requires case A05/);
  const claimed = antigravityRun();
  claimed.scenarios[0] = { ...claimed.scenarios[0], observations: [] };
  assert.throws(() => assertAntigravityRunEvidence(claimed), /A01 outcome does not match its observations/);
});

test("the run refuses fields it does not know, and bodies have nowhere to go", () => {
  assert.throws(() => assertAntigravityRunEvidence({ ...antigravityRun(), transcript: "x" }), /unknown field transcript/);
  const withBody = antigravityRun();
  withBody.scenarios[0] = { ...withBody.scenarios[0], body: "peer text" };
  assert.throws(() => assertAntigravityRunEvidence(withBody), /unknown field body/);
});

test("observations come from ACC's own results, not from what the operator hoped", () => {
  const delivery = { data: { message: { messageId: "message_a01" }, delivery: [
    { recipientParticipantId: "agy-1", outcome: "offered", transport: "live-adapter" }] } };
  const relayLog = [
    JSON.stringify({ at: at(1), event: "pushed", messageId: "message_a01" }),
    JSON.stringify({ at: at(1), event: "pushed", messageId: "message_other" }),
  ].join("\n");
  const observations = observationsFrom({ caseId: "A01", delivery, relayLog, messageId: "message_a01",
    observed: [`model-turn=started-without-user-input@${at(1)}`], at: at(2) });
  assert.equal(scenarioPasses("A01", observations), true);

  const durable = { delivery: [{ recipientParticipantId: "agy-1", outcome: "queued", transport: "durable" }] };
  assert.equal(scenarioPasses("A01", observationsFrom({ caseId: "A01", delivery: durable, relayLog,
    messageId: "message_a01", observed: [`model-turn=started-without-user-input@${at(1)}`], at: at(2) })),
  false, "a durable fallback is not an idle wake");
  const twice = `${relayLog}\n${JSON.stringify({ at: at(3), event: "pushed", messageId: "message_a01" })}`;
  assert.equal(observationsFrom({ caseId: "A04", delivery, relayLog: twice, messageId: "message_a01",
    observed: [], at: at(4) }).find(item => item.kind === "relay-push").outcome, "pushed-twice");
});

test("an installed-hook Antigravity pass needs its own product evidence", () => {
  assert.doesNotThrow(() => validateCapture(capture, { productEvidence: antigravityRun() }));
  assert.throws(() => validateCapture(capture), /installed-hook pass requires product evidence/);
  assert.throws(() => validateCapture({ ...capture, packageSha256: "d".repeat(64) },
    { productEvidence: antigravityRun() }), /package SHA-256 matches product evidence/);
  assert.throws(() => validateCapture({ ...capture, client: "gemini-cli" },
    { productEvidence: antigravityRun() }), /installed-hook capture client is one of codex-cli, antigravity-cli, claude-code/);
});
