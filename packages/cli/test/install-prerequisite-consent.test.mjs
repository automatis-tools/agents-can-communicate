import assert from "node:assert/strict";
import test from "node:test";
import { decideDelivery, decisionOf } from "../src/install-delivery-consent.mjs";
import { nativeRemediation } from "../src/native-delivery-status.mjs";

const detected = [{ adapterId: "codex", displayName: "Codex CLI", present: true,
  nativeDelivery: { consentAvailable: true },
  nativeServiceSetup: { state: "needed", requiresInstall: true, cliVersion: "0.154.0" } }];
const recorded = decision => [{ adapterId: "codex", deliveryPolicy: "actionable", deliveryDecision: decision }];
async function decide({ decision, answer = true, ...overrides } = {}) {
  const questions = [];
  const result = await decideDelivery({ options: {}, detected, recorded: decision ? recorded(decision) : [],
    dryRun: false, runtime: { isInteractive: () => true,
      confirm: async question => { questions.push(question); return answer; } }, ...overrides });
  return { ...result, questions };
}

test("the single setup choice discloses the official Codex download and retains that scope", async () => {
  const result = await decide();
  assert.equal(result.questions.length, 1);
  assert.match(result.questions[0], /download.*Codex.*0\.154\.0/i);
  assert.equal(result.deliveryDecisionByAdapter.codex.installPrerequisites, true);
  assert.equal(decisionOf(recorded(result.deliveryDecisionByAdapter.codex)[0]).installPrerequisites, true);
});

test("old service consent receives one expanded choice, and its accepted or declined answer persists", async () => {
  for (const answer of [true, false]) {
    const previous = { source: "interactive-accepted", completeSetup: true };
    const result = await decide({ decision: previous, answer });
    assert.equal(result.questions.length, 1);
    assert.equal(result.deliveryByAdapter.codex, "actionable");
    assert.equal(result.deliveryDecisionByAdapter.codex.installPrerequisites, answer);
    const repeated = await decide({ decision: result.deliveryDecisionByAdapter.codex });
    assert.equal(repeated.questions.length, 0);
    assert.equal(repeated.deliveryDecisionByAdapter.codex.installPrerequisites, answer);
  }
});

test("preview and unattended reinstall do not expand old consent", async () => {
  for (const extra of [{ dryRun: true }, { runtime: { isInteractive: () => false } }]) {
    const result = await decide({ decision: { source: "interactive-accepted", completeSetup: true }, ...extra });
    assert.equal(result.questions.length, 0);
    assert.equal(result.deliveryDecisionByAdapter.codex.installPrerequisites, undefined);
  }
});

test("a legacy opted-in user who declines the download is not asked again", async () => {
  const result = await decide({ recorded: recorded(undefined), answer: false });
  assert.equal(result.questions.length, 1);
  assert.equal(result.deliveryDecisionByAdapter.codex.installPrerequisites, false);
  const repeated = await decide({ decision: result.deliveryDecisionByAdapter.codex });
  assert.equal(repeated.questions.length, 0);
});

test("explicit setup grants prerequisite scope only for an enabled policy", async () => {
  for (const delivery of ["actionable", "all", "off"]) {
    const result = await decide({ options: { delivery } });
    assert.equal(result.questions.length, 0);
    assert.equal(result.deliveryDecisionByAdapter.codex.installPrerequisites, delivery !== "off");
  }
});

test("doctor gives a working explicit opt-in after a saved download decline", () => {
  for (const policy of ["actionable", "all"]) {
    const steps = nativeRemediation({ ...detected[0],
      deliveryDecision: { source: "interactive-accepted", completeSetup: true, installPrerequisites: false },
      nativeDelivery: { eligibility: "degraded", configured: true, policy,
        runtime: "waiting", reasonCode: "native_endpoint_unavailable" } });
    assert.match(steps.join("\n"), new RegExp(`acc install --adapter codex --delivery ${policy}`));
  }
});
