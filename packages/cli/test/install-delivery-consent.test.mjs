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
const decide = overrides => decideDelivery({ options: {}, detected: DETECTED, recorded: [],
  dryRun: false, ...overrides });
const ON = { source: "default-enabled", completeSetup: true };
const CANNOT = { source: "unsupported-default", completeSetup: false };
const LEGACY = { source: "legacy-unknown", completeSetup: false };

test("a fresh install turns delivery on for every client that can receive it", async () => {
  const result = await decide();

  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "actionable", codex: "actionable", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter,
    { claude_code: ON, codex: ON, grok: CANNOT });
});

test("the install asks nothing, whatever kind of run it is", async () => {
  const runtime = { isInteractive: () => true,
    confirm: async () => { throw new Error("must not prompt"); } };

  for (const dryRun of [false, true]) {
    const result = await decide({ runtime, dryRun });
    assert.equal(result.deliveryByAdapter.codex, "actionable");
  }
});

test("a fresh install says delivery is on, what it can cost, and how to turn it off", async () => {
  const { notes } = await decide();
  const text = notes.join("\n");

  assert.match(text, /live delivery on for Claude Code, Codex/);
  assert.doesNotMatch(text, /Grok/);
  assert.match(text, /tokens/);
  assert.match(text, /acc install --delivery off/);
  assert.match(text, /Claude Code sessions that bypass permission prompts ask before each ACC wake/);
  assert.match(text, /crossSessionInbound to accept/);
});

test("a preview shows the same policy and says it would apply it", async () => {
  const preview = await decide({ dryRun: true });

  assert.deepEqual(preview.deliveryByAdapter,
    { claude_code: "actionable", codex: "actionable", grok: "off" });
  assert.match(preview.notes.join("\n"), /would turn live delivery on for Claude Code, Codex/);
});

test("the Claude Code wake note appears only when Claude Code was turned on", async () => {
  const { notes } = await decide({ detected: [CODEX] });

  assert.doesNotMatch(notes.join("\n"), /crossSessionInbound/);
});

test("a run that turns nothing on says nothing", async () => {
  const result = await decide({ recorded: [
    { adapterId: "claude_code", deliveryPolicy: "actionable", deliveryDecision: ON },
    { adapterId: "codex", deliveryPolicy: "actionable", deliveryDecision: ON },
  ] });

  assert.deepEqual(result.notes, []);
});

test("explicit delivery policies record complete-setup intent", async () => {
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
    assert.deepEqual(result.notes, []);
  }
});

test("a person's own off stays off", async () => {
  const declined = { source: "interactive-declined", completeSetup: false };
  const explicit = { source: "explicit-option", completeSetup: false };
  const result = await decide({ recorded: [
    { adapterId: "claude_code", deliveryPolicy: "off", deliveryDecision: declined },
    { adapterId: "codex", deliveryPolicy: "off", deliveryDecision: explicit },
  ] });

  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "off", codex: "off", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter,
    { claude_code: declined, codex: explicit, grok: CANNOT });
  assert.deepEqual(result.notes, []);
});

test("an off that ACC set itself turns on once the client can receive delivery", async () => {
  for (const decision of [
    { source: "noninteractive-default", completeSetup: false },
    CANNOT,
    undefined,
  ]) {
    const result = await decide({ detected: [CODEX], recorded: [{ adapterId: "codex",
      deliveryPolicy: "off", ...(decision ? { deliveryDecision: decision } : {}) }] });

    assert.equal(result.deliveryByAdapter.codex, "actionable", decision?.source);
    assert.deepEqual(result.deliveryDecisionByAdapter.codex, ON, decision?.source);
  }
});

test("an off that ACC set stays off while the client cannot receive delivery", async () => {
  const result = await decide({ detected: [unsupported], recorded: [
    { adapterId: "grok", deliveryPolicy: "off", deliveryDecision: CANNOT },
  ] });

  assert.deepEqual(result.deliveryByAdapter, { grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter, { grok: CANNOT });
});

test("a recorded policy that is on survives reinstall", async () => {
  const accepted = { source: "interactive-accepted", completeSetup: true };
  const result = await decide({ recorded: [
    { adapterId: "claude_code", deliveryPolicy: "all", deliveryDecision: accepted },
    { adapterId: "codex", deliveryPolicy: "actionable", deliveryDecision: ON },
  ] });

  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "all", codex: "actionable", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter,
    { claude_code: accepted, codex: ON, grok: CANNOT });
});

test("invalid and missing legacy provenance is normalized without changing an enabled policy", async () => {
  const result = await decide({ recorded: [
    { adapterId: "claude_code", deliveryPolicy: "all" },
    { adapterId: "codex", deliveryPolicy: "actionable",
      deliveryDecision: { source: "invented", completeSetup: true } },
  ] });

  assert.deepEqual(result.deliveryByAdapter,
    { claude_code: "all", codex: "actionable", grok: "off" });
  assert.deepEqual(result.deliveryDecisionByAdapter,
    { claude_code: LEGACY, codex: LEGACY, grok: CANNOT });
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
    { source: "default-enabled", completeSetup: false, policy: "actionable" },
    { source: "default-enabled", completeSetup: true, policy: "off" },
    { source: "legacy-unknown", completeSetup: true, policy: "all" },
  ];

  for (const entry of incoherent) {
    const result = await decide({
      detected: [CODEX],
      recorded: [{ adapterId: "codex", deliveryPolicy: entry.policy,
        deliveryDecision: { source: entry.source, completeSetup: entry.completeSetup } }],
    });
    // An off with no coherent record of a person's choice is ACC's own off.
    const off = entry.policy === "off";
    assert.equal(result.deliveryByAdapter.codex, off ? "actionable" : entry.policy, entry.source);
    assert.deepEqual(result.deliveryDecisionByAdapter.codex, off ? ON : LEGACY, entry.source);
  }
});

test("a client already on completes the setup it still needs", async () => {
  const entries = [
    { ...CLAUDE, nativeServiceSetup: { state: "needed" } },
    { ...CODEX, nativeServiceSetup: { state: "blocked" } },
  ];
  const result = await decide({ detected: entries, recorded: [
    { adapterId: "claude_code", deliveryPolicy: "all" },
    { adapterId: "codex", deliveryPolicy: "actionable",
      deliveryDecision: { source: "explicit-option", completeSetup: false } },
  ] });

  assert.deepEqual(result.deliveryByAdapter, { claude_code: "all", codex: "actionable" });
  assert.deepEqual(result.deliveryDecisionByAdapter, { claude_code: ON, codex: ON });
  assert.deepEqual(result.notes, []);
});

test("complete setup is left as recorded on reinstall", async () => {
  const explicit = { source: "explicit-option", completeSetup: true };
  const result = await decide({
    detected: [{ ...CODEX, nativeServiceSetup: { state: "needed" } }],
    recorded: [{ adapterId: "codex", deliveryPolicy: "actionable", deliveryDecision: explicit }],
  });

  assert.deepEqual(result.deliveryByAdapter, { codex: "actionable" });
  assert.deepEqual(result.deliveryDecisionByAdapter, { codex: explicit });
});
