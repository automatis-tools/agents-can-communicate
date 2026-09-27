import assert from "node:assert/strict";
import test from "node:test";

import { decideDelivery } from "../src/install-command.mjs";
import { decisionOf } from "../src/install-delivery-consent.mjs";

/**
 * The second question `acc install` asks for Antigravity CLI: may ACC commands
 * run there without an approval prompt (issue #214).
 *
 * Asked only where it changes something - live delivery on, the client
 * reporting that its rule is absent and can be added - and only once: the
 * answer is recorded beside the delivery decision as `allowCommands`. It is
 * never asked by a preview or a run with nobody at the terminal, and an
 * explicit `--delivery` answers it the way it answers every other part of
 * complete setup.
 */
const RULE = "command(/Users/dana/.gemini/config/acc/acc-cli.sh)";
const SETTINGS = "/Users/dana/.gemini/antigravity-cli/settings.json";
const approval = state => ({ state, rule: RULE, file: SETTINGS, owned: false,
  setup: state === "prompts" ? `add ${RULE} to permissions.allow in ${SETTINGS}` : null,
  diagnostic: `approval is ${state}` });
const antigravity = (state = "prompts", eligible = true) => ({
  adapterId: "antigravity", displayName: "Antigravity CLI", present: true, version: "1.2.12",
  commandApproval: approval(state),
  nativeDelivery: eligible
    ? { state: "eligible", reasonCode: null, eligibility: { eligible: true },
      activationPlan: { eligible: true, reasonCode: null, mechanisms: [] } }
    : { state: "unsupported", reasonCode: "native_delivery_unsupported", activationPlan: null },
});
// What 0.8.1 recorded for an operator who accepted live delivery.
const ACCEPTED = [{ adapterId: "antigravity", deliveryPolicy: "actionable",
  deliveryDecision: { source: "interactive-accepted", completeSetup: true } }];
const neverConfirm = async () => { throw new Error("must not prompt"); };
const answering = (...answers) => {
  const questions = [];
  return { questions, runtime: { isInteractive: () => true,
    confirm: async question => { questions.push(question); return answers.shift(); } } };
};
const decide = overrides => decideDelivery({ options: {}, detected: [antigravity()],
  recorded: ACCEPTED, dryRun: false,
  runtime: { isInteractive: () => true, confirm: neverConfirm }, ...overrides });

test("an accepted live delivery is asked once more, about the approval prompt", async () => {
  const { questions, runtime } = answering(true);

  const result = await decide({ runtime });

  assert.equal(questions.length, 1);
  assert.match(questions[0], /Antigravity CLI/);
  assert.match(questions[0], /without an approval prompt/);
  assert.equal(questions[0].includes(RULE), true, "the question does not name the rule");
  assert.equal(questions[0].includes(SETTINGS), true, "the question does not name the file");
  assert.match(questions[0], /No: .*live wake stops at/s);
  assert.deepEqual(result.deliveryDecisionByAdapter.antigravity,
    { source: "interactive-accepted", completeSetup: true, allowCommands: true });
  assert.deepEqual(result.commandApprovalAsked, ["antigravity"]);
});

test("a No is recorded, keeps live delivery, and is not asked again", async () => {
  const declined = await decide(answering(false));
  assert.equal(declined.deliveryByAdapter.antigravity, "actionable");
  assert.equal(declined.deliveryDecisionByAdapter.antigravity.allowCommands, false);

  const again = await decide({ recorded: [{ ...ACCEPTED[0],
    deliveryDecision: declined.deliveryDecisionByAdapter.antigravity }] });
  assert.equal(again.deliveryDecisionByAdapter.antigravity.allowCommands, false);
  assert.deepEqual(again.commandApprovalAsked, []);
});

test("a fresh install asks about delivery first, then about the prompt", async () => {
  const { questions, runtime } = answering(true, true);

  const result = await decide({ recorded: [], runtime });

  assert.equal(questions.length, 2);
  assert.match(questions[0], /peer-request setup/);
  assert.match(questions[1], /without an approval prompt/);
  assert.deepEqual(result.deliveryDecisionByAdapter.antigravity,
    { source: "interactive-accepted", completeSetup: true, allowCommands: true });
});

test("a declined live delivery is never followed by the prompt question", async () => {
  const { questions, runtime } = answering(false);

  const result = await decide({ recorded: [], runtime });

  assert.equal(questions.length, 1);
  assert.equal(Object.hasOwn(result.deliveryDecisionByAdapter.antigravity, "allowCommands"),
    false);
});

test("nothing to ask when the rule is there, cannot apply, or cannot be read", async () => {
  for (const state of ["allowed", "unmatchable", "unreadable"]) {
    const result = await decide({ detected: [antigravity(state)] });
    assert.deepEqual(result.commandApprovalAsked, [], state);
    assert.equal(Object.hasOwn(result.deliveryDecisionByAdapter.antigravity, "allowCommands"),
      false, state);
  }
});

test("a client without an approval report is never asked", async () => {
  const { commandApproval, ...plain } = antigravity();
  assert.equal(typeof commandApproval, "object");

  const result = await decide({ detected: [plain] });

  assert.deepEqual(result.commandApprovalAsked, []);
});

test("a preview and a run with nobody to ask leave the prompt in place", async () => {
  const noninteractive = await decide({ runtime: { isInteractive: () => false,
    confirm: neverConfirm } });
  assert.equal(Object.hasOwn(noninteractive.deliveryDecisionByAdapter.antigravity,
    "allowCommands"), false);

  const preview = await decide({ dryRun: true });
  assert.equal(Object.hasOwn(preview.deliveryDecisionByAdapter.antigravity, "allowCommands"),
    false);
  assert.match(preview.notes.join("\n"), /approval prompt/);
});

test("an explicit delivery answers the prompt question with it, never by asking", async () => {
  for (const [delivery, allowCommands] of [["actionable", true], ["all", true],
    ["off", false]]) {
    const result = await decide({ options: { delivery } });
    assert.equal(result.deliveryDecisionByAdapter.antigravity.allowCommands, allowCommands,
      delivery);
    assert.deepEqual(result.commandApprovalAsked, []);
  }
});

test("a recorded answer survives, and one that contradicts its policy does not", () => {
  const record = (deliveryPolicy, allowCommands) => ({ deliveryPolicy,
    deliveryDecision: { source: "explicit-option", completeSetup: deliveryPolicy !== "off",
      allowCommands } });

  assert.equal(decisionOf(record("actionable", true)).allowCommands, true);
  assert.equal(decisionOf(record("off", false)).allowCommands, false);
  // A yes to running ACC commands unasked, for a delivery that is off.
  assert.deepEqual(decisionOf(record("off", true)),
    { source: "legacy-unknown", completeSetup: false });
  assert.deepEqual(decisionOf(record("actionable", "yes")),
    { source: "legacy-unknown", completeSetup: false });
});
