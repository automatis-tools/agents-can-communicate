import assert from "node:assert/strict";
import test from "node:test";

import { decideDelivery } from "../src/install-command.mjs";
import { decisionOf } from "../src/install-delivery-consent.mjs";

/**
 * Antigravity's allow rule is not a decision anyone is asked to make.
 *
 * The user decided on 2026-09-27 that ACC always writes it when it installs the
 * Antigravity adapter (#214): "there is no sense in something not being
 * enabled". So `acc install` asks nothing about it, records nothing about it,
 * and a record written while it still had a question of its own - carrying
 * `allowCommands` - is read as the decision it is, with that field ignored.
 */
const antigravity = {
  adapterId: "antigravity", displayName: "Antigravity CLI", present: true, version: "1.2.12",
  commandApproval: { state: "prompts", rule: "command(/Users/dana/.gemini/config/acc/acc-cli.sh)",
    file: "/Users/dana/.gemini/antigravity-cli/settings.json", owned: false,
    diagnostic: "each ACC command waits for approval" },
  nativeDelivery: { state: "eligible", reasonCode: null, eligibility: { eligible: true },
    activationPlan: { eligible: true, reasonCode: null, mechanisms: [] } },
};
// What 0.8.1 recorded for an operator who accepted live delivery.
const ON_0_8_1 = [{ adapterId: "antigravity", deliveryPolicy: "actionable",
  deliveryDecision: { source: "interactive-accepted", completeSetup: true } }];
const neverConfirm = async () => { throw new Error("must not prompt"); };

test("an accepted live delivery is asked nothing more", async () => {
  const result = await decideDelivery({ options: {}, detected: [antigravity],
    recorded: ON_0_8_1, dryRun: false,
    runtime: { isInteractive: () => true, confirm: neverConfirm } });

  assert.deepEqual(result.deliveryDecisionByAdapter.antigravity,
    { source: "interactive-accepted", completeSetup: true });
  assert.equal(Object.hasOwn(result, "commandApprovalAsked"), false);
});

test("a fresh install asks one question, about delivery", async () => {
  const questions = [];
  const result = await decideDelivery({ options: {}, detected: [antigravity], recorded: [],
    dryRun: false, runtime: { isInteractive: () => true,
      confirm: async question => { questions.push(question); return true; } } });

  assert.equal(questions.length, 1);
  assert.match(questions[0], /peer-request setup/);
  assert.deepEqual(result.deliveryDecisionByAdapter.antigravity,
    { source: "interactive-accepted", completeSetup: true });
});

test("an explicit delivery records its own decision and nothing about the rule", async () => {
  for (const delivery of ["actionable", "all", "off"]) {
    const result = await decideDelivery({ options: { delivery }, detected: [antigravity],
      recorded: ON_0_8_1, dryRun: false,
      runtime: { isInteractive: () => true, confirm: neverConfirm } });
    assert.deepEqual(result.deliveryDecisionByAdapter.antigravity,
      { source: "explicit-option", completeSetup: delivery !== "off" }, delivery);
  }
});

test("a preview says nothing about an approval prompt", async () => {
  const result = await decideDelivery({ options: {}, detected: [antigravity],
    recorded: ON_0_8_1, dryRun: true,
    runtime: { isInteractive: () => true, confirm: neverConfirm } });

  assert.doesNotMatch(result.notes.join("\n"), /approval prompt/);
});

test("a record carrying the old answer is read, and the answer ignored", () => {
  for (const [deliveryPolicy, deliveryDecision, expected] of [
    ["actionable", { source: "interactive-accepted", completeSetup: true, allowCommands: true },
      { source: "interactive-accepted", completeSetup: true }],
    ["actionable", { source: "interactive-accepted", completeSetup: true, allowCommands: false },
      { source: "interactive-accepted", completeSetup: true }],
    // Incoherent under the old question, and harmless now that nothing reads it.
    ["off", { source: "explicit-option", completeSetup: false, allowCommands: true },
      { source: "explicit-option", completeSetup: false }],
    ["all", { source: "explicit-option", completeSetup: true, allowCommands: "yes" },
      { source: "explicit-option", completeSetup: true }],
  ]) {
    assert.deepEqual(decisionOf({ deliveryPolicy, deliveryDecision }), expected,
      JSON.stringify(deliveryDecision));
  }
});
