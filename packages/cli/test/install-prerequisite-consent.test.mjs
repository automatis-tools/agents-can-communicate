import assert from "node:assert/strict";
import test from "node:test";
import { decideDelivery, decisionOf } from "../src/install-delivery-consent.mjs";
import { nativeRemediation } from "../src/native-delivery-status.mjs";

const detected = [{ adapterId: "codex", displayName: "Codex CLI", present: true,
  nativeDelivery: { consentAvailable: true },
  nativeServiceSetup: { state: "needed", requiresInstall: true, cliVersion: "0.154.0" } }];
const recorded = decision => [{ adapterId: "codex", deliveryPolicy: "actionable", deliveryDecision: decision }];
const decide = ({ decision, ...overrides } = {}) => decideDelivery({ options: {}, detected,
  recorded: decision ? recorded(decision) : [], dryRun: false, ...overrides });

test("the default covers the official Codex download and retains that scope", async () => {
  const result = await decide();

  assert.equal(result.deliveryByAdapter.codex, "actionable");
  assert.equal(result.deliveryDecisionByAdapter.codex.installPrerequisites, true);
  assert.equal(decisionOf(recorded(result.deliveryDecisionByAdapter.codex)[0]).installPrerequisites, true);
});

test("older service consent gains the download and keeps it on the next run", async () => {
  const result = await decide({ decision: { source: "interactive-accepted", completeSetup: true } });

  assert.equal(result.deliveryByAdapter.codex, "actionable");
  assert.equal(result.deliveryDecisionByAdapter.codex.installPrerequisites, true);
  const repeated = await decide({ decision: result.deliveryDecisionByAdapter.codex });
  assert.deepEqual(repeated.deliveryDecisionByAdapter.codex, result.deliveryDecisionByAdapter.codex);
});

test("a legacy opted-in client gains the download too", async () => {
  const result = await decide({ recorded: recorded(undefined) });

  assert.equal(result.deliveryDecisionByAdapter.codex.installPrerequisites, true);
});

test("a download someone declined stays declined", async () => {
  const declined = { source: "interactive-accepted", completeSetup: true, installPrerequisites: false };
  const result = await decide({ decision: declined });

  assert.deepEqual(result.deliveryDecisionByAdapter.codex, declined);
});

test("explicit setup grants prerequisite scope only for an enabled policy", async () => {
  for (const delivery of ["actionable", "all", "off"]) {
    const result = await decide({ options: { delivery } });
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
