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

test("evidence applies forward from the version that recorded it", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence()] },
    offerMessage: noop,
  }));
  const on = (clientVersion, platform = "darwin-arm64") =>
    sdk.effectiveCapabilities(adapter, { clientVersion, platform }).delivery.livePush;

  for (const clientVersion of ["1.2.3", "1.2.4", "1.3.0", "99.0.0"]) {
    assert.equal(on(clientVersion), true, clientVersion);
  }
  assert.equal(on("1.2.2"), false, "a client older than every row stays unproven");
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

test("an unreadable client version is judged by the newest evidence", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence(),
      evidence({ version: "1.4.0", result: "fail", provenanceId: "regressed",
        limitations: ["the vendor changed the push surface"] })] },
    offerMessage: noop,
  }));
  const on = facts => sdk.effectiveCapabilities(adapter, facts).delivery.livePush;

  // A running hook proves the integration is installed; a client that changed
  // the shape of --version must not cost its user delivery.
  assert.equal(on({ clientVersion: "unknown", platform: "darwin-arm64" }), false,
    "the newest row decides, and here it records a loss");
  assert.equal(on({ clientVersion: "unknown", platform: "unknown" }), false);
  assert.equal(on({ clientVersion: "1.3.0", platform: "darwin-arm64" }), true);
});

test("delivery uses only the communication-first vocabulary", () => {
  assert.deepEqual(sdk.CAPABILITY_SHAPE.delivery, ["nextTurn", "livePush", "replyRoute"]);
  assert.equal(Object.hasOwn(sdk.CAPABILITY_SHAPE, "execution"), false);
});

test("a recorded failure withdraws an inherited capability, and a later pass restores it", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence(),
      evidence({ version: "1.4.0", result: "fail", provenanceId: "regressed",
        limitations: ["the vendor changed the push surface"] }),
      evidence({ version: "1.6.0", provenanceId: "restored" })] },
    offerMessage: noop,
  }));
  const on = clientVersion => sdk.effectiveCapabilities(adapter,
    { clientVersion, platform: "darwin-arm64" }).delivery.livePush;

  assert.equal(on("1.3.0"), true, "the first capture still applies below the regression");
  for (const clientVersion of ["1.4.0", "1.5.9"]) {
    assert.equal(on(clientVersion), false, clientVersion);
  }
  for (const clientVersion of ["1.6.0", "2.0.0"]) {
    assert.equal(on(clientVersion), true, clientVersion);
  }
});

test("capturing one capability leaves every other capability standing", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true, nextTurn: true } },
    certification: { evidence: [
      evidence({ capability: "delivery.nextTurn", provenanceId: "next-turn" }),
      evidence({ version: "1.4.0", provenanceId: "live-push-1-4-0" })] },
    offerMessage: noop,
    renderContextResult: () => ({ text: "", offeredMessageIds: [], includedAttentionIds: [] }),
  }));

  const later = sdk.effectiveCapabilities(adapter,
    { clientVersion: "1.4.0", platform: "darwin-arm64" }).delivery;
  assert.equal(later.livePush, true);
  assert.equal(later.nextTurn, true,
    "a capture that names one capability must not withdraw the others");
});

test("evidence crosses platforms until that platform records its own", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence(),
      evidence({ version: "1.3.0", platform: "linux-x64", result: "fail",
        provenanceId: "linux-regressed", limitations: ["no session bus"] })] },
    offerMessage: noop,
  }));
  const on = (clientVersion, platform) => sdk.effectiveCapabilities(adapter,
    { clientVersion, platform }).delivery.livePush;

  assert.equal(on("1.2.3", "linux-x64"), true, "a capture travels to a platform with no rows");
  assert.equal(on("1.3.0", "linux-x64"), false, "that platform's own row decides there");
  assert.equal(on("1.3.0", "darwin-arm64"), true, "a platform with its own row keeps it");
  assert.equal(on("1.3.0", "win32-x64"), false,
    "a loss is the newest thing anyone observed, and win32 has recorded nothing");
});

test("a failure wins a tie at the deciding version", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence(),
      evidence({ platform: "linux-x64", result: "fail", provenanceId: "linux-fail",
        limitations: ["no session bus"] })] },
    offerMessage: noop,
  }));

  assert.equal(sdk.effectiveCapabilities(adapter,
    { clientVersion: "1.2.3", platform: "win32-x64" }).delivery.livePush, false,
  "platforms disagreeing at one version resolve to the recorded loss");
});

test("a prerelease client version is judged as its release triple", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence()] },
    offerMessage: noop,
  }));
  const on = clientVersion => sdk.effectiveCapabilities(adapter,
    { clientVersion, platform: "darwin-arm64" }).delivery.livePush;

  assert.equal(on("1.3.0-beta.1"), true);
  assert.equal(on("1.2.2-rc.1"), false, "a prerelease below every row is still below them");
});

test("a refused capability says which evidence refused it", () => {
  const adapter = sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true, nextTurn: true } },
    certification: { evidence: [evidence(),
      evidence({ version: "1.4.0", result: "fail", provenanceId: "regressed",
        limitations: ["the vendor changed the push surface"] }),
      evidence({ capability: "delivery.nextTurn", version: "1.3.0",
        provenanceId: "next-turn" })] },
    offerMessage: noop,
    renderContextResult: () => ({ text: "", offeredMessageIds: [], includedAttentionIds: [] }),
  }));
  const why = (clientVersion, capability, platform = "darwin-arm64") =>
    sdk.capabilityEvidence(adapter, { clientVersion, platform }, capability);

  assert.deepEqual(why("1.3.0", "delivery.livePush"),
    { granted: true, reason: null, version: "1.2.3" });
  assert.deepEqual(why("1.4.0", "delivery.livePush"),
    { granted: false, reason: "recorded-failure", version: "1.4.0" });
  assert.deepEqual(why("1.2.2", "delivery.livePush"),
    { granted: false, reason: "older-than-evidence", version: "1.2.3" });
  assert.deepEqual(why("1.2.9", "delivery.nextTurn"),
    { granted: false, reason: "older-than-evidence", version: "1.3.0" },
    "each capability names the first version that proved it, not the adapter's oldest row");
  assert.deepEqual(why("2.0.0", "guards.beforeWrite"),
    { granted: false, reason: "undeclared", version: null });
});

test("certificationFloor is no longer an adapter field", () => {
  assert.throws(() => sdk.defineAdapter(base({
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [evidence()] },
    certificationFloor: { "darwin-arm64": "1.2.3" },
    offerMessage: noop,
  })), /certificationFloor/);
});
