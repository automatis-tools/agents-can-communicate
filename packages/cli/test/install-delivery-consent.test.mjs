import assert from "node:assert/strict";
import test from "node:test";

import { decideDelivery } from "../src/install-command.mjs";

const eligible = (adapterId, displayName, command, extra = {}) => ({
  adapterId,
  displayName,
  present: true,
  version: "2.1.258",
  capabilities: { delivery: { nextTurn: adapterId === "claude_code" } },
  outgoingDelivery: { setup: `Configure local grants for ${displayName}.` },
  nativeDelivery: {
    state: "eligible",
    reasonCode: null,
    realExecutable: `/vendor/${command}`,
    probe: null,
    eligibility: { eligible: true, protocolContract: `${command}-native-v1` },
    activationPlan: { eligible: true, reasonCode: null, mechanisms: [{
      kind: "native-service", serviceId: `${command}-service`, preExisting: true,
      applyCommand: null, teardownCommand: null,
    }] },
  },
  ...extra,
});

const unsupported = {
  adapterId: "grok",
  displayName: "Grok",
  present: true,
  version: "1.0.0",
  nativeDelivery: { state: "unsupported", reasonCode: "native_delivery_unsupported",
    activationPlan: null },
};

const CLAUDE = eligible("claude_code", "Claude Code", "claude");
const CODEX = eligible("codex", "Codex", "codex");
const DETECTED = [CLAUDE, CODEX, unsupported];
const neverConfirm = async () => { throw new Error("must not prompt"); };
const decide = overrides => decideDelivery({ options: {}, detected: DETECTED, recorded: [],
  dryRun: false, runtime: { isInteractive: () => true, confirm: neverConfirm }, ...overrides });

test("two undecided clients share one complete-setup answer", async () => {
  const questions = [];
  const result = await decide({ runtime: { isInteractive: () => true,
    confirm: async question => { questions.push(question); return true; } } });

  assert.equal(questions.length, 1);
  assert.deepEqual(result.asked, ["claude_code", "codex"]);
  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "actionable", codex: "actionable", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter, {
    claude_code: { source: "interactive-accepted", completeSetup: true },
    codex: { source: "interactive-accepted", completeSetup: true },
    grok: { source: "unsupported-default", completeSetup: false },
  });
  assert.match(questions[0], /Claude Code/);
  assert.match(questions[0], /Codex/);
  assert.match(questions[0], /tokens/);
  assert.match(questions[0], /local permission grants/i);
  assert.doesNotMatch(questions[0], /Channels/);
  // A Claude session that bypasses permission prompts holds each wake.
  assert.match(questions[0], /Claude Code sessions that bypass permission prompts ask before each ACC wake/);
  assert.match(questions[0], /start/i);
});

test("one No keeps every undecided client off with declined provenance", async () => {
  let confirms = 0;
  const result = await decide({ runtime: { isInteractive: () => true,
    confirm: async () => { confirms += 1; return false; } } });

  assert.equal(confirms, 1);
  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "off", codex: "off", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter, {
    claude_code: { source: "interactive-declined", completeSetup: false },
    codex: { source: "interactive-declined", completeSetup: false },
    grok: { source: "unsupported-default", completeSetup: false },
  });
});

test("noninteractive and dry-run defaults do not confirm", async () => {
  const noninteractive = await decide({ runtime: { isInteractive: () => false,
    confirm: neverConfirm } });
  assert.deepEqual(noninteractive.deliveryByAdapter,
    { claude_code: "off", codex: "off", grok: "off" });
  assert.deepEqual(noninteractive.deliveryDecisionByAdapter, {
    claude_code: { source: "noninteractive-default", completeSetup: false },
    codex: { source: "noninteractive-default", completeSetup: false },
    grok: { source: "unsupported-default", completeSetup: false },
  });
  assert.deepEqual(noninteractive.asked, []);

  const preview = await decide({ dryRun: true });
  assert.deepEqual(preview.deliveryByAdapter,
    { claude_code: "off", codex: "off", grok: "off" });
  assert.deepEqual(preview.deliveryDecisionByAdapter, {
    claude_code: { source: "noninteractive-default", completeSetup: false },
    codex: { source: "noninteractive-default", completeSetup: false },
    grok: { source: "unsupported-default", completeSetup: false },
  });
  assert.deepEqual(preview.asked, []);
  assert.match(preview.notes.join("\n"), /interactive choices were not made/);
});

test("explicit delivery policies record complete-setup intent and never confirm", async () => {
  for (const [delivery, completeSetup] of [
    ["actionable", true], ["all", true], ["off", false],
  ]) {
    const result = await decide({ options: { delivery } });
    assert.deepEqual(result.deliveryByAdapter,
      { claude_code: delivery, codex: delivery, grok: delivery });
    assert.deepEqual(result.deliveryDecisionByAdapter, {
      claude_code: { source: "explicit-option", completeSetup },
      codex: { source: "explicit-option", completeSetup },
      grok: { source: "explicit-option", completeSetup },
    });
    assert.deepEqual(result.asked, []);
  }
});

test("known decisions and a recorded non-off policy survive reinstall", async () => {
  const accepted = { source: "interactive-accepted", completeSetup: true };
  const declined = { source: "interactive-declined", completeSetup: false };
  const result = await decide({ recorded: [
    { adapterId: "claude_code", deliveryPolicy: "all", deliveryDecision: accepted },
    { adapterId: "codex", deliveryPolicy: "off", deliveryDecision: declined },
  ] });

  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "all", codex: "off", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter, {
    claude_code: accepted,
    codex: declined,
    grok: { source: "unsupported-default", completeSetup: false },
  });
  assert.deepEqual(result.asked, []);
});

test("recorded defaults still receive one later interactive choice", async () => {
  let confirms = 0;
  const result = await decide({ recorded: [
    { adapterId: "claude_code", deliveryPolicy: "off",
      deliveryDecision: { source: "noninteractive-default", completeSetup: false } },
    { adapterId: "codex", deliveryPolicy: "off",
      deliveryDecision: { source: "unsupported-default", completeSetup: false } },
  ], runtime: { isInteractive: () => true,
    confirm: async () => { confirms += 1; return true; } } });

  assert.equal(confirms, 1);
  assert.deepEqual(result.asked, ["claude_code", "codex"]);
  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "actionable", codex: "actionable", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter, {
    claude_code: { source: "interactive-accepted", completeSetup: true },
    codex: { source: "interactive-accepted", completeSetup: true },
    grok: { source: "unsupported-default", completeSetup: false },
  });
});

test("a noninteractive reinstall retains existing default and legacy provenance", async () => {
  const result = await decide({ recorded: [
    { adapterId: "claude_code", deliveryPolicy: "off" },
    { adapterId: "codex", deliveryPolicy: "off",
      deliveryDecision: { source: "unsupported-default", completeSetup: false } },
  ], runtime: { isInteractive: () => false, confirm: neverConfirm } });

  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "off", codex: "off", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter, {
    claude_code: { source: "legacy-unknown", completeSetup: false },
    codex: { source: "unsupported-default", completeSetup: false },
    grok: { source: "unsupported-default", completeSetup: false },
  });
  assert.deepEqual(result.asked, []);
});

test("invalid and missing legacy provenance is normalized without changing policy", async () => {
  const result = await decide({ recorded: [
    { adapterId: "claude_code", deliveryPolicy: "all" },
    { adapterId: "codex", deliveryPolicy: "actionable",
      deliveryDecision: { source: "invented", completeSetup: true } },
  ] });

  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "all", codex: "actionable", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter, {
    claude_code: { source: "legacy-unknown", completeSetup: false },
    codex: { source: "legacy-unknown", completeSetup: false },
    grok: { source: "unsupported-default", completeSetup: false },
  });
  assert.deepEqual(result.asked, []);
});

test("source, setup value, and recorded policy must describe one coherent decision", async () => {
  const incoherent = [
    { source: "interactive-accepted", completeSetup: false, policy: "actionable" },
    { source: "interactive-accepted", completeSetup: true, policy: "off" },
    { source: "interactive-declined", completeSetup: true, policy: "off" },
    { source: "interactive-declined", completeSetup: false, policy: "all" },
    { source: "explicit-option", completeSetup: true, policy: "off" },
    { source: "explicit-option", completeSetup: false, policy: "actionable" },
    { source: "noninteractive-default", completeSetup: true, policy: "off" },
    { source: "noninteractive-default", completeSetup: false, policy: "all" },
    { source: "unsupported-default", completeSetup: true, policy: "off" },
    { source: "unsupported-default", completeSetup: false, policy: "actionable" },
    { source: "legacy-unknown", completeSetup: true, policy: "all" },
  ];

  for (const entry of incoherent) {
    const result = await decide({
      detected: [CODEX],
      recorded: [{ adapterId: "codex", deliveryPolicy: entry.policy,
        deliveryDecision: { source: entry.source, completeSetup: entry.completeSetup } }],
      runtime: { isInteractive: () => false, confirm: neverConfirm },
    });
    assert.equal(result.deliveryByAdapter.codex, entry.policy, entry.source);
    assert.deepEqual(result.deliveryDecisionByAdapter.codex,
      { source: "legacy-unknown", completeSetup: false }, entry.source);
    assert.deepEqual(result.asked, [], entry.source);
  }
});

test("incoherent non-off decisions still receive one expanded interactive choice", async () => {
  const entries = [
    { ...CLAUDE, nativeServiceSetup: { state: "needed" } },
    { ...CODEX, nativeServiceSetup: { state: "blocked" } },
    { ...eligible("fixture", "Fixture", "fixture"),
      nativeServiceSetup: { state: "needed" } },
  ];
  const recorded = [
    { adapterId: "claude_code", deliveryPolicy: "all",
      deliveryDecision: { source: "noninteractive-default", completeSetup: true } },
    { adapterId: "codex", deliveryPolicy: "actionable",
      deliveryDecision: { source: "interactive-declined", completeSetup: true } },
    { adapterId: "fixture", deliveryPolicy: "actionable",
      deliveryDecision: { source: "explicit-option", completeSetup: false } },
  ];
  let confirms = 0;
  const result = await decide({ detected: entries, recorded,
    runtime: { isInteractive: () => true,
      confirm: async () => { confirms += 1; return true; } } });

  assert.equal(confirms, 1);
  assert.deepEqual(result.asked, ["claude_code", "codex", "fixture"]);
  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "all", codex: "actionable", fixture: "actionable" });
  assert.deepEqual(result.deliveryDecisionByAdapter, {
    claude_code: { source: "interactive-accepted", completeSetup: true },
    codex: { source: "interactive-accepted", completeSetup: true },
    fixture: { source: "interactive-accepted", completeSetup: true },
  });
});

test("one answer expands setup for legacy opted-in clients that need service work", async () => {
  const detected = [
    { ...CLAUDE, nativeServiceSetup: { state: "needed" } },
    { ...CODEX, nativeServiceSetup: { state: "blocked" } },
  ];
  const recorded = [
    { adapterId: "claude_code", deliveryPolicy: "all" },
    { adapterId: "codex", deliveryPolicy: "actionable" },
  ];
  let confirms = 0;
  const accepted = await decide({ detected, recorded,
    runtime: { isInteractive: () => true, confirm: async () => { confirms += 1; return true; } } });
  assert.equal(confirms, 1);
  assert.deepEqual(accepted.deliveryByAdapter,
    { claude_code: "all", codex: "actionable" });
  assert.deepEqual(accepted.deliveryDecisionByAdapter, {
    claude_code: { source: "interactive-accepted", completeSetup: true },
    codex: { source: "interactive-accepted", completeSetup: true },
  });

  const declined = await decide({ detected, recorded,
    runtime: { isInteractive: () => true, confirm: async () => false } });
  assert.deepEqual(declined.deliveryByAdapter,
    { claude_code: "all", codex: "actionable" });
  assert.deepEqual(declined.deliveryDecisionByAdapter, {
    claude_code: { source: "legacy-unknown", completeSetup: false },
    codex: { source: "legacy-unknown", completeSetup: false },
  });
});

test("complete consent suppresses expanded setup confirmation on reinstall", async () => {
  const result = await decide({
    detected: [{ ...CODEX, nativeServiceSetup: { state: "needed" } }],
    recorded: [{ adapterId: "codex", deliveryPolicy: "actionable",
      deliveryDecision: { source: "explicit-option", completeSetup: true } }],
  });

  assert.deepEqual(result.deliveryByAdapter, { codex: "actionable" });
  assert.deepEqual(result.deliveryDecisionByAdapter,
    { codex: { source: "explicit-option", completeSetup: true } });
  assert.deepEqual(result.asked, []);
});
