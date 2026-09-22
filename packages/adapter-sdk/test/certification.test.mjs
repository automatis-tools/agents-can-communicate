import assert from "node:assert/strict";
import test from "node:test";

import * as sdk from "../src/index.mjs";

const noop = async () => ({ ok: true, changes: [], diagnostics: [] });

const base = (overrides = {}) => ({
  id: "example",
  displayName: "Example",
  client: { command: "example", certificationName: "example-client" },
  capabilities: {},
  certification: { evidence: [] },
  detect: noop,
  install: noop,
  uninstall: noop,
  doctor: noop,
  normalizeHook: () => ({ kind: "sessionStart", sessionId: "s", cwd: "/tmp" }),
  renderContext: () => "",
  ...overrides,
});

const evidence = (overrides = {}) => ({
  client: "example-client",
  version: "1.2.3",
  platform: "darwin-arm64",
  observedAt: "2026-08-16",
  capability: "delivery.livePush",
  fixture: "fixtures/live-push.json",
  provenance: "fixtures/certification-provenance.json",
  provenanceId: "live-push",
  idleBehavior: "accepted without interrupting a turn",
  busyBehavior: "queued until the current turn completed",
  authorityLevel: "advisory",
  limitations: ["requires an already-running client session"],
  result: "pass",
  ...overrides,
});

test("certification helpers are public adapter-sdk contracts", () => {
  assert.equal(typeof sdk.validateCertification, "function");
  assert.equal(typeof sdk.effectiveCapabilities, "function");
});

test("method existence without passing evidence cannot declare a capability", () => {
  assert.throws(() => sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    offerMessage: noop,
  })), /evidence/);
});

test("exact passing evidence permits the declared capability", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence()] },
    offerMessage: noop,
  }));

  assert.equal(adapter.capabilities.delivery.livePush, true);
  assert.equal(Object.isFrozen(adapter.certification), true);
  assert.equal(Object.isFrozen(adapter.certification.evidence), true);
  assert.equal(Object.isFrozen(adapter.certification.evidence[0].limitations), true);
});

test("an exact version and platform are required for an effective true", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence()] },
    offerMessage: noop,
  }));

  assert.equal(sdk.effectiveCapabilities(adapter,
    { clientVersion: "1.2.3", platform: "darwin-arm64" }).delivery.livePush, true);
  assert.equal(sdk.effectiveCapabilities(adapter,
    { clientVersion: "99.0.0", platform: "darwin-arm64" }).delivery.livePush, false);
  assert.equal(sdk.effectiveCapabilities(adapter,
    { clientVersion: "1.2.3", platform: "linux-x64" }).delivery.livePush, false);
  assert.equal(sdk.effectiveCapabilities(adapter,
    { clientVersion: "unknown", platform: "darwin-arm64" }).delivery.livePush, false);
});

test("a retained failure capture never enables the capability", () => {
  assert.throws(() => sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence({ result: "fail" })] },
    offerMessage: noop,
  })), /passing evidence/);
});

test("certification validates every required evidence fact", () => {
  for (const key of ["client", "version", "platform", "observedAt", "capability",
    "fixture", "idleBehavior", "busyBehavior", "authorityLevel"]) {
    assert.throws(() => sdk.validateCertification({ evidence: [evidence({ [key]: "" })] }),
      new RegExp(key), `an empty ${key} was accepted`);
  }
  assert.throws(() => sdk.validateCertification({ evidence: [evidence({ limitations: "none" })] }),
    /limitations/);
  assert.throws(() => sdk.validateCertification({ evidence: [evidence({ result: "maybe" })] }),
    /result/);
});

test("certification is a closed schema and cannot retain mutable nested extras", () => {
  assert.throws(() => sdk.validateCertification({ evidence: [evidence()], extra: true }),
    /unknown certification field extra/);
  assert.throws(() => sdk.validateCertification({ evidence: [evidence({
    audit: { mutable: true },
  })] }), /unknown certification evidence field audit/);
});

test("reserved unknown and malformed client facts cannot certify a capability", () => {
  for (const [key, value] of [
    ["version", "unknown"], ["platform", "unknown"], ["version", "latest"],
    ["platform", "darwin"], ["observedAt", "2026-02-30"],
    ["observedAt", "yesterday"],
  ]) {
    assert.throws(() => sdk.validateCertification({ evidence: [evidence({ [key]: value })] }),
      new RegExp(key), `${key}=${value} was accepted`);
  }
});

test("contradictory duplicate certification tuples are rejected", () => {
  assert.throws(() => sdk.validateCertification({ evidence: [
    evidence(), evidence({ result: "fail", idleBehavior: "unobserved" }),
  ] }), /duplicate certification tuple/);
});

test("embedded delimiter bytes cannot make distinct certification tuples collide", () => {
  const delimiter = "\u0000";
  const tail = ["delivery.livePush", "x", "1.2.3", "darwin-arm64",
    "delivery.replyRoute"].join(delimiter);
  const prefix = ["example-client", "1.2.3", "darwin-arm64",
    "delivery.livePush", "x"].join(delimiter);
  const manifest = sdk.validateCertification({ evidence: [
    evidence({ client: "example-client", capability: tail }),
    evidence({ client: prefix, capability: "delivery.replyRoute" }),
  ] });

  assert.equal(manifest.evidence.length, 2);
  assert.notEqual(manifest.evidence[0].client, manifest.evidence[1].client);
  assert.notEqual(manifest.evidence[0].capability, manifest.evidence[1].capability);
  assert.throws(() => sdk.defineAdapter(base({ certification: manifest })),
    /unknown certified capability/,
    "collision-safe tuple identity must not loosen the known capability gate");
});

test("both unknown effective client facts degrade to all false", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence()] },
    offerMessage: noop,
  }));

  assert.equal(sdk.effectiveCapabilities(adapter,
    { clientVersion: "unknown", platform: "unknown" }).delivery.livePush, false);
});

test("delivery uses only the communication-first vocabulary", () => {
  assert.deepEqual(sdk.CAPABILITY_SHAPE.delivery, ["nextTurn", "livePush", "replyRoute"]);
  assert.equal(Object.hasOwn(sdk.CAPABILITY_SHAPE, "execution"), false);
});

test("a certification floor extends a platform's evidence to later stable versions", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true, nextTurn: true } },
    certification: { evidence: [evidence(),
      evidence({ capability: "delivery.nextTurn", provenanceId: "next-turn" })] },
    certificationFloor: { "darwin-arm64": "1.2.3" },
    offerMessage: noop,
    renderContextResult: () => ({ text: "", offeredMessageIds: [], includedAttentionIds: [] }),
  }));
  const on = facts => sdk.effectiveCapabilities(adapter, facts).delivery;

  for (const clientVersion of ["1.2.3", "1.2.4", "1.3.0", "2.0.0"]) {
    assert.deepEqual({ ...on({ clientVersion, platform: "darwin-arm64" }) },
      { ...on({ clientVersion: "1.2.3", platform: "darwin-arm64" }) }, clientVersion);
    assert.equal(on({ clientVersion, platform: "darwin-arm64" }).nextTurn, true, clientVersion);
  }
  for (const facts of [{ clientVersion: "1.2.2", platform: "darwin-arm64" },
    { clientVersion: "1.3.0-beta.1", platform: "darwin-arm64" },
    { clientVersion: "1.3.0", platform: "linux-x64" },
    { clientVersion: "unknown", platform: "darwin-arm64" }]) {
    assert.equal(on(facts).nextTurn, false, JSON.stringify(facts));
  }
});

test("a later version's own capture wins over the floor, capability by capability", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true, nextTurn: true } },
    certification: { evidence: [evidence(),
      evidence({ capability: "delivery.nextTurn", provenanceId: "next-turn" }),
      evidence({ version: "1.4.0", result: "fail", provenanceId: "regressed",
        limitations: ["the vendor changed the push surface"] })] },
    certificationFloor: { "darwin-arm64": "1.2.3" },
    offerMessage: noop,
    renderContextResult: () => ({ text: "", offeredMessageIds: [], includedAttentionIds: [] }),
  }));

  const later = sdk.effectiveCapabilities(adapter, { clientVersion: "1.4.0", platform: "darwin-arm64" });
  assert.equal(later.delivery.livePush, false, "a recorded failure is not overruled by the floor");
  assert.equal(later.delivery.nextTurn, true, "an uncaptured capability still follows the floor");
});

test("a certification floor must name a stable version with passing evidence", () => {
  const declare = certificationFloor => sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence()] },
    certificationFloor,
    offerMessage: noop,
  }));

  assert.throws(() => declare({ "darwin-arm64": "1.2.4" }), /certificationFloor .* has no passing evidence/);
  assert.throws(() => declare({ "darwin-arm64": "1.2.3-beta" }), /stable version/);
  assert.throws(() => declare({ "beos-ppc": "1.2.3" }), /platform/);
  assert.throws(() => declare(["1.2.3"]), /certificationFloor/);
  assert.equal(Object.isFrozen(declare({ "darwin-arm64": "1.2.3" }).certificationFloor), true);
});
