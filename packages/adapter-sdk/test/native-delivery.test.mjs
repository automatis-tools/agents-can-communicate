import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { defineAdapter } from "../src/capabilities.mjs";
import { NATIVE_ACTIVATION_KINDS, NATIVE_BINDING_MODES, NATIVE_REASON_CODES, PLANNABLE_ACTIVATION_KINDS,
  compareStableVersions,
  evaluateNativeEligibility, evaluateVersionContract, validateNativeActivationPlan,
  validateNativeDeliveryContract, validateNativeHandshake } from "../src/native-delivery.mjs";

// Kept cohesive above 300 lines because every case exercises one closed
// contract (manifest, probe, handshake, activation plan) against the same
// fixture adapter; splitting would duplicate that fixture and hide the
// interplay between the static minimum and the runtime probe.

const noop = async () => ({ ok: true, changes: [], diagnostics: [] });
const livePushEvidence = (version = "2.1.258", platform = "darwin-arm64") => ({
  client: "fixture-client", version, platform, observedAt: "2026-09-02T12:00:00.000Z",
  capability: "delivery.livePush", fixture: `fixtures/delivery/fixture-client-${version}.json`,
  provenance: "fixtures/certification-provenance.json", provenanceId: `native-${version}`,
  idleBehavior: "offered", busyBehavior: "queued_after_turn", authorityLevel: "experimental",
  limitations: ["fixture only"], result: "pass",
});
const nativeDelivery = {
  minimum: "2.1.258",
  anchors: [{ version: "2.1.258", protocolContract: "fixture-native-v1" }],
  knownBad: [{ from: "2.1.300", to: "2.1.302", reasonCode: "known_bad_version" },
    { version: "2.1.310", reasonCode: "known_bad_version" }],
  activationKinds: ["native-service"],
};
const manifest = (overrides = {}) => ({
  id: "fixture", displayName: "Fixture",
  client: { command: "fixture", certificationName: "fixture-client", versionArgs: ["--version"] },
  capabilities: { delivery: { livePush: true } },
  certification: { evidence: [livePushEvidence()] },
  nativeDelivery,
  detect: noop, install: noop, uninstall: noop, doctor: noop,
  normalizeHook: () => ({ kind: "sessionStart", sessionId: "s", cwd: "/tmp" }),
  renderContext: () => "",
  offerMessage: async () => ({ accepted: true, transport: "fixture", clientVersion: "2.1.258" }),
  probeNativeDelivery: async () => probe(),
  planNativeActivation: async () => ({ eligible: false, reasonCode: "unsupported_shell", mechanisms: [] }),
  bindNativeSession: async () => handshake(),
  ...overrides,
});
const probe = (overrides = {}) => ({
  supported: true, clientVersion: "2.1.258", protocolContract: "fixture-native-v1",
  executableFingerprint: `sha256:${"a".repeat(64)}`, modes: ["livePush", "idleWake"],
  reasonCode: null, ...overrides,
});
const handshake = (overrides = {}) => ({
  supported: true, clientVersion: "2.1.258", protocolContract: "fixture-native-v1",
  modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
  opaqueEndpointRef: "adapter-owned-endpoint-id", leaseUntil: "2026-09-02T12:01:00.000Z",
  reasonCode: null, ...overrides,
});
const adapter = () => defineAdapter(manifest());
const evaluate = (clientVersion, options = {}) => evaluateNativeEligibility(adapter(),
  { clientVersion, probe: probe({ clientVersion }), ...options });
const ELIGIBLE = Object.freeze({ eligible: true, reasonCode: null, minimumVersion: "2.1.258",
  protocolContract: "fixture-native-v1", modes: ["livePush", "idleWake"] });
const isUsage = error => error.exitCode === EXIT.USAGE || error.code === EXIT.USAGE
  || /usage|native/i.test(error.message);

test("the exact minimum is eligible with the captured protocol and probe modes", () => {
  assert.deepEqual(evaluate("2.1.258"), ELIGIBLE);
});

test("a newer stable client is admitted by the same captured protocol", () => {
  assert.deepEqual(evaluate("2.4.0"), ELIGIBLE);
  assert.deepEqual(evaluate("3.0.0"), ELIGIBLE);
  assert.deepEqual(evaluate("2.1.258+build.7"), ELIGIBLE);
});

test("version comparison is numeric, not lexical", () => {
  assert.equal(compareStableVersions("2.10.0", "2.9.99"), 1);
  assert.equal(compareStableVersions("2.9.99", "2.10.0"), -1);
  assert.equal(compareStableVersions("0.152.1", "0.152.1"), 0);
  assert.equal(compareStableVersions("1.0.0+a", "1.0.0+b"), 0);
  assert.throws(() => compareStableVersions("2.1.0-beta.1", "2.1.0"), isUsage);
  assert.throws(() => compareStableVersions("v2.1.0", "2.1.0"), isUsage);
});

test("older and known-bad clients fail closed with a reason", () => {
  const closed = (reasonCode, extra = {}) => ({ eligible: false, reasonCode,
    minimumVersion: "2.1.258", protocolContract: "fixture-native-v1", modes: [], ...extra });
  assert.deepEqual(evaluate("2.1.257"), closed("below_minimum_version"));
  assert.deepEqual(evaluate("2.1.301"), closed("known_bad_version"));
  assert.deepEqual(evaluate("2.1.300"), closed("known_bad_version"));
  assert.deepEqual(evaluate("2.1.302"), closed("known_bad_version"));
  assert.deepEqual(evaluate("2.1.310"), closed("known_bad_version"));
  assert.deepEqual(evaluate("2.1.303"), ELIGIBLE);
  assert.deepEqual(evaluate(undefined), closed("version_unavailable"));
  assert.deepEqual(evaluate("unknown"), closed("version_unavailable"));
  assert.deepEqual(evaluate("build from source"), closed("version_unavailable"));
});

// A prerelease is judged by its release triple, as hook capabilities are since
// 2026-09-22: a prerelease of a version above the minimum is not an older
// client, and what admits it is the protocol contract the probe reports.
test("a prerelease is judged by its release triple", () => {
  assert.deepEqual(evaluate("2.2.0-beta.1"), ELIGIBLE);
  assert.deepEqual(evaluate("2.1.258-rc.1"), ELIGIBLE);
  assert.deepEqual(evaluate("2.1.257-rc.1").reasonCode, "below_minimum_version");
  assert.deepEqual(evaluate("2.1.301-beta.2").reasonCode, "known_bad_version");
  assert.deepEqual(evaluate("2.1.310-rc.1").reasonCode, "known_bad_version");
  assert.deepEqual(evaluateVersionContract(adapter(), { clientVersion: "3.0.0-alpha.3" }),
    { reasonCode: null, minimumVersion: "2.1.258", protocolContract: "fixture-native-v1" });
});

// The captures were taken on one platform; the minimum they establish applies
// on every platform, and the probe decides on the machine in hand. See
// docs/design/2026-09-26-native-delivery-across-platforms.md.
test("the same version gets the same verdict whatever platform the caller names", () => {
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64",
    undefined, null, ""]) {
    assert.deepEqual(evaluate("2.1.258", { platform }), ELIGIBLE, String(platform));
    assert.deepEqual(evaluate("2.1.257", { platform }).reasonCode, "below_minimum_version",
      String(platform));
    assert.deepEqual(evaluateVersionContract(adapter(), { clientVersion: "2.4.0", platform }),
      { reasonCode: null, minimumVersion: "2.1.258", protocolContract: "fixture-native-v1" },
      String(platform));
  }
});

test("unsupported, timed-out, mismatched, and wrong-protocol probes fail closed", () => {
  const closed = reasonCode => ({ eligible: false, reasonCode, minimumVersion: "2.1.258",
    protocolContract: "fixture-native-v1", modes: [] });
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ supported: false, modes: [],
    reasonCode: "feature_probe_failed" }) }), closed("feature_probe_failed"));
  // The probe reports no version at all; the rule falls back to the detected
  // one (2.1.258, which passes) before the probe's own timeout closes it.
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ supported: false, modes: [],
    reasonCode: "probe_timeout", clientVersion: null }) }), closed("probe_timeout"));
  assert.deepEqual(evaluate("2.1.258", { probe: null }), closed("feature_probe_failed"));
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ protocolContract: "fixture-native-v2" }) }),
    closed("protocol_mismatch"));
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ modes: ["idleWake"] }) }),
    closed("feature_probe_failed"));
});

test("eligibility follows the version that will serve, not the detected binary", () => {
  // The service reports a different build from the CLI ACC detected. Both are
  // above the captured minimum, so the delivery is eligible.
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ clientVersion: "2.1.259" }) }), ELIGIBLE);
  // The rule is applied to the serving version, so a serving version below the
  // minimum is refused and named, even when the detected binary is newer.
  assert.deepEqual(evaluate("2.1.999", { probe: probe({ clientVersion: "2.1.257" }) }),
    { eligible: false, reasonCode: "below_minimum_version", minimumVersion: "2.1.258",
      protocolContract: "fixture-native-v1", modes: [] });
  // A denylisted serving version stays refused.
  assert.deepEqual(evaluate("2.1.303", { probe: probe({ clientVersion: "2.1.310" }) }),
    { eligible: false, reasonCode: "known_bad_version", minimumVersion: "2.1.258",
      protocolContract: "fixture-native-v1", modes: [] });
});

test("a malformed probe cannot throw once the detected version already fails the static rule", () => {
  // The probe reports no version (so the rule falls back to the detected one)
  // and carries an unknown field that would fail probe shape validation. The
  // detected version is already below the minimum, so the rule closes before
  // the probe is ever validated, and the malformed shape never surfaces.
  assert.deepEqual(evaluate("2.1.100", { probe: probe({ clientVersion: null, transcript: "leak" }) }),
    { eligible: false, reasonCode: "below_minimum_version", minimumVersion: "2.1.258",
      protocolContract: "fixture-native-v1", modes: [] });
});

test("modes are the ordered intersection of probe modes and the closed vocabulary", () => {
  assert.deepEqual(NATIVE_BINDING_MODES, ["livePush", "idleWake", "busyQueue", "replyRoute"]);
  assert.throws(() => evaluate("2.1.258", { probe: probe({ modes: ["busyQueue", "livePush", "teleport"] }) }),
    isUsage);
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ modes: ["busyQueue", "livePush"] }) }).modes,
    ["livePush", "busyQueue"]);
});

test("the result and the manifest contract are deeply frozen", () => {
  const result = evaluate("2.1.258");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.modes), true);
  const contract = adapter().nativeDelivery;
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.anchors), true);
  assert.equal(Object.isFrozen(contract.anchors[0]), true);
  assert.equal(contract.minimum, "2.1.258");
  assert.equal(Object.isFrozen(contract.knownBad[0]), true);
  assert.equal(Object.isFrozen(contract.activationKinds), true);
});

test("the live policy always comes from the installation record", () => {
  const recorded = adapter().nativeDelivery;
  assert.equal(recorded.policySource, "installation-record");
  const withRecord = defineAdapter(manifest({ nativeDelivery: {
    ...nativeDelivery, policySource: "installation-record" } }));
  assert.equal(withRecord.nativeDelivery.policySource, "installation-record");
});

test("a native offer carries the message unless the contract says it is a wake", () => {
  assert.equal(adapter().nativeDelivery.offerKind, "message");
  const wake = defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery, offerKind: "wake" } }));
  assert.equal(wake.nativeDelivery.offerKind, "wake");
  for (const offerKind of [null, "", "push", "WAKE"]) {
    assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery, offerKind } })),
      /offerKind must be message or wake/);
  }
});

test("an invalid native policy source is rejected instead of falling back", () => {
  // bootstrap-environment was the policy a Claude shell shim exported; the
  // shim is gone, so nothing can supply that source any more.
  for (const policySource of [null, "", "environment", "INSTALLATION-RECORD", "bootstrap-environment"]) {
    assert.throws(() => defineAdapter(manifest({ nativeDelivery: {
      ...nativeDelivery, policySource } })), /policySource/);
  }
});

test("unknown manifest and probe keys are rejected", () => {
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery, maximum: "9.9.9" } })),
    /unknown nativeDelivery field maximum/);
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery,
    anchors: [{ ...nativeDelivery.anchors[0], captured: true }] } })), /unknown .*anchor.* captured/);
  // The per-platform shape 0.8.0 and earlier declared. No shim: the message
  // names the field and the design that removed it.
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery,
    minimumByPlatform: { "darwin-arm64": "2.1.258" } } })),
  /minimumByPlatform.*2026-09-26-native-delivery-across-platforms/);
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery,
    anchors: [{ ...nativeDelivery.anchors[0], platform: "darwin-arm64" }] } })),
  /anchor.*platform.*2026-09-26-native-delivery-across-platforms/);
  assert.throws(() => evaluate("2.1.258", { probe: probe({ transcript: "x" }) }),
    /unknown .*probe.* transcript/);
  assert.throws(() => evaluate("2.1.258", { probe: probe({ executableFingerprint: "md5:abc" }) }),
    /executableFingerprint/);
});

test("every anchor needs passing livePush certification for the same client and version",
  () => {
    assert.throws(() => defineAdapter(manifest({ certification: { evidence: [] } })),
      /anchor .*2\.1\.258.* passing delivery\.livePush/);
    // The platform an anchor's evidence was taken on is provenance, not a
    // condition: a capture on any platform proves the version.
    assert.equal(defineAdapter(manifest({ certification: { evidence: [
      livePushEvidence("2.1.258", "linux-x64")] } })).nativeDelivery.minimum, "2.1.258");
    assert.throws(() => defineAdapter(manifest({ certification: { evidence: [
      { ...livePushEvidence(), result: "fail" }] } })), /passing delivery\.livePush/);
    assert.throws(() => defineAdapter(manifest({ certification: { evidence: [
      livePushEvidence("2.1.259")] } })), /passing delivery\.livePush/);
    // The minimum is the first passing capture: the lowest anchor, exactly.
    assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery,
      minimum: "2.1.250" } })), /minimum .*first passing capture/);
    assert.throws(() => defineAdapter(manifest({ certification: { evidence: [livePushEvidence(),
      livePushEvidence("2.1.259")] }, nativeDelivery: { ...nativeDelivery, minimum: "2.1.259",
      anchors: [{ version: "2.1.259", protocolContract: "fixture-native-v1" },
        { version: "2.1.258", protocolContract: "fixture-native-v1" }] } })),
    /minimum .*first passing capture/);
    assert.equal(defineAdapter(manifest({ certification: { evidence: [livePushEvidence(),
      livePushEvidence("2.1.259")] }, nativeDelivery: { ...nativeDelivery,
      anchors: [{ version: "2.1.259", protocolContract: "fixture-native-v1" },
        { version: "2.1.258", protocolContract: "fixture-native-v1" }] } })).nativeDelivery.minimum,
    "2.1.258");
  });

test("the static contract is closed in every field", () => {
  const bad = patch => () => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery, ...patch } }));
  assert.throws(bad({ activationKinds: ["native-service", "telepathy"] }), /activationKinds/);
  // A kind install records still carry, and no adapter may ask for again.
  assert.throws(bad({ activationKinds: ["shell-bootstrap"] }), /activationKinds/);
  assert.throws(bad({ activationKinds: [] }), /activationKinds/);
  assert.throws(bad({ activationKinds: ["native-service", "native-service"] }), /activationKinds/);
  assert.throws(bad({ minimum: "2.1" }), /minimum/);
  assert.throws(bad({ minimum: "2.1.258-rc.1" }), /minimum/);
  assert.throws(bad({ minimum: undefined }), /minimum/);
  assert.throws(bad({ minimum: null }), /minimum/);
  assert.throws(bad({ knownBad: [{ from: "2.1.302", to: "2.1.300", reasonCode: "known_bad_version" }] }),
    /knownBad/);
  assert.throws(bad({ knownBad: [{ version: "2.1.310", reasonCode: "broken" }] }), /knownBad/);
  assert.throws(bad({ anchors: [] }), /anchors/);
  assert.throws(bad({ anchors: [{ version: "2.1.258", protocolContract: "Fixture Native" }] }),
    /protocolContract/);
  assert.throws(bad({ anchors: [{ version: "2.1", protocolContract: "fixture-native-v1" }] }),
    /anchor 0 version must be a stable version/);
  assert.throws(bad({ anchors: [{ version: "2.1.259-rc.1", protocolContract: "fixture-native-v1" }] }),
    /anchor 0 version must be a stable version/);
  assert.deepEqual(NATIVE_ACTIVATION_KINDS, ["shell-bootstrap", "native-config", "native-service"]);
  assert.deepEqual(PLANNABLE_ACTIVATION_KINDS, ["native-config", "native-service"]);
  assert.throws(() => validateNativeDeliveryContract(nativeDelivery, { certification: { evidence: [] },
    client: "fixture-client" }), /passing delivery\.livePush/);
});

test("a native contract requires its three adapter methods", () => {
  for (const method of ["probeNativeDelivery", "planNativeActivation", "bindNativeSession"]) {
    assert.throws(() => defineAdapter(manifest({ [method]: undefined })), new RegExp(method));
  }
  assert.equal(typeof adapter().probeNativeDelivery, "function");
});

test("a regular adapter without a native contract keeps live delivery off", () => {
  const regular = defineAdapter(manifest({ nativeDelivery: undefined, capabilities: {},
    probeNativeDelivery: undefined, planNativeActivation: undefined, bindNativeSession: undefined,
    offerMessage: undefined }));
  assert.equal(regular.nativeDelivery, undefined);
  assert.equal(regular.capabilities.delivery.livePush, false);
  assert.deepEqual(evaluateNativeEligibility(regular, { clientVersion: "2.1.258",
    probe: probe() }), { eligible: false,
    reasonCode: "native_delivery_unsupported", minimumVersion: null, protocolContract: null,
    modes: [] });
});

// The contract check is also handed adapter objects that never went through
// defineAdapter - a registry entry assembled by hand, a fixture. Every shape
// that is not a contract has to come back as a reason code, because the callers
// are a delivery offer and a restart decision, and a TypeError raised inside
// either surfaces far from the declaration that caused it. A null declaration
// used to do exactly that: it is not `undefined`, so it fell through to
// `contract.minimum` and threw.
test("a declaration that is not a contract answers with a reason code rather than throwing", () => {
  const closed = reasonCode => ({ reasonCode, minimumVersion: null, protocolContract: null });
  const judge = nativeDelivery => evaluateVersionContract({ nativeDelivery },
    { clientVersion: "2.1.258" });

  for (const missing of [undefined, null]) {
    assert.deepEqual(judge(missing), closed("native_delivery_unsupported"), String(missing));
  }
  assert.deepEqual(evaluateVersionContract(null, { clientVersion: "2.1.258" }),
    closed("native_delivery_unsupported"), "no adapter at all");

  // Present, but with no minimum or no anchor to judge against: a declaration
  // that captured nothing, which is no contract.
  for (const partial of ["x", 5, true, [], {}, { minimum: "2.1.258" },
    { minimum: "2.1.258", anchors: [] }, { anchors: [{ version: "2.1.258", protocolContract: "x-v1" }] },
    { minimum: "2.1.258", anchors: [{ version: "2.1.259", protocolContract: "x-v1" }] },
    { minimum: 5, anchors: [{ version: 5, protocolContract: "x-v1" }] },
    { minimum: "", anchors: [{ version: "", protocolContract: "x-v1" }] },
    { minimumByPlatform: { "darwin-arm64": "2.1.258" },
      anchors: [{ platform: "darwin-arm64", version: "2.1.258", protocolContract: "x-v1" }] }]) {
    assert.deepEqual(judge(partial), closed("native_delivery_unsupported"), JSON.stringify(partial));
  }
});

test("the session handshake rechecks the static rule and publishes only adapter facts", () => {
  const ok = validateNativeHandshake(adapter(), { clientVersion: "2.1.259",
    handshake: handshake({ clientVersion: "2.1.259" }) });
  assert.deepEqual(ok, { ok: true, reasonCode: null, clientVersion: "2.1.259",
    protocolContract: "fixture-native-v1",
    modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
    opaqueEndpointRef: "adapter-owned-endpoint-id", leaseUntil: "2026-09-02T12:01:00.000Z" });
  assert.equal(Object.isFrozen(ok), true);
  const closed = reasonCode => ({ ok: false, reasonCode, clientVersion: null,
    protocolContract: "fixture-native-v1",
    modes: [], opaqueEndpointRef: null, leaseUntil: null });
  const check = (clientVersion, patch, platform) => validateNativeHandshake(adapter(),
    { clientVersion, platform, handshake: handshake({ clientVersion, ...patch }) });
  assert.deepEqual(check("2.1.257", {}), closed("below_minimum_version"));
  assert.deepEqual(check("2.1.301", {}), closed("known_bad_version"));
  assert.deepEqual(check("2.1.258", { supported: false, modes: [], opaqueEndpointRef: null,
    leaseUntil: null, reasonCode: "handshake_timeout" }), closed("handshake_timeout"));
  // The handshake reports no version at all; the rule falls back to the
  // detected one (2.1.258, which passes) before the timeout closes it.
  assert.deepEqual(check("2.1.258", { supported: false, modes: [], opaqueEndpointRef: null,
    leaseUntil: null, reasonCode: "handshake_timeout", clientVersion: null }),
  closed("handshake_timeout"));
  // The handshake names the session that will actually serve; a build newer
  // than the detected binary is admitted by that version, not refused for it -
  // and the verdict reports that version, because it is the one the admission
  // rests on and the one a caller must record on the binding it publishes.
  // Reporting the detected 2.1.258 here would put a version on the binding
  // that nothing ever verified.
  assert.deepEqual(check("2.1.258", { clientVersion: "2.1.260" }), { ok: true, reasonCode: null,
    clientVersion: "2.1.260",
    protocolContract: "fixture-native-v1", modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
    opaqueEndpointRef: "adapter-owned-endpoint-id", leaseUntil: "2026-09-02T12:01:00.000Z" });
  // A handshake that names no version at all is judged by the detected one, so
  // that is what the verdict admitted and what it reports.
  assert.equal(validateNativeHandshake(adapter(), { clientVersion: "2.1.258",
    handshake: handshake({ clientVersion: null }) }).clientVersion, "2.1.258");
  // The rule is applied to the serving version, so a serving version below
  // the minimum is refused even when the detected binary is newer.
  assert.deepEqual(check("2.1.999", { clientVersion: "2.1.257" }), closed("below_minimum_version"));
  assert.deepEqual(check("2.1.258", { protocolContract: "fixture-native-v2" }), closed("protocol_mismatch"));
  // A prerelease session above the minimum is admitted, and the binding records
  // the version string the handshake reported.
  assert.deepEqual(check("2.1.259-rc.1", {}), { ...ok, clientVersion: "2.1.259-rc.1" });
  assert.deepEqual(check("2.1.257-rc.1", {}), closed("below_minimum_version"));
  assert.deepEqual(check("2.1.258", { modes: ["idleWake"] }), closed("handshake_failed"));
  // A platform the captures never named admits the same handshake.
  assert.deepEqual(check("2.1.258", {}, "linux-x64"), { ...ok, clientVersion: "2.1.258" });
  assert.deepEqual(check("2.1.258", {}, "win32-x64"), { ...ok, clientVersion: "2.1.258" });
  assert.throws(() => check("2.1.258", { executableFingerprint: `sha256:${"a".repeat(64)}` }),
    /unknown .*handshake.* executableFingerprint/);
  assert.throws(() => check("2.1.258", { opaqueEndpointRef: "" }), /opaqueEndpointRef/);
  assert.throws(() => check("2.1.258", { leaseUntil: "soon" }), /leaseUntil/);
});

test("an activation plan is closed, frozen, and never shell source", () => {
  const plan = validateNativeActivationPlan({ eligible: true, reasonCode: null, mechanisms: [
    { kind: "native-config", artifactIds: ["adapter-owned-config-block"] },
    { kind: "native-service", serviceId: "vendor-daemon", preExisting: false,
      applyCommand: { executable: "/abs/vendor/bin/client", args: ["vendor", "bootstrap"] },
      teardownCommand: null },
  ] });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.mechanisms[0].artifactIds), true);
  assert.equal(Object.isFrozen(plan.mechanisms[1].applyCommand), true);
  const bad = value => () => validateNativeActivationPlan(value);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [], shell: "sh" }), /unknown .*plan/);
  assert.throws(bad({ eligible: false, reasonCode: "unsupported_shell", mechanisms: [
    { kind: "native-config", artifactIds: ["x"] }] }), /ineligible/);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [{ kind: "shell-bootstrap",
    command: "claude", realExecutable: "/abs/claude", prefixArgs: [] }] }),
  /shell-bootstrap activation was removed/);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [{ kind: "native-service",
    serviceId: "d", preExisting: false, applyCommand: "codex app-server daemon start",
    teardownCommand: null }] }), /applyCommand/);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [{ kind: "launchd" }] }), /kind/);
  assert.deepEqual(validateNativeActivationPlan({ eligible: false, reasonCode: "unsupported_shell",
    mechanisms: [] }), { eligible: false, reasonCode: "unsupported_shell", mechanisms: [] });
});

test("an embedded client session is a closed reason every reader accepts", () => {
  assert.equal(NATIVE_REASON_CODES.includes("client_session_embedded"), true);
  assert.deepEqual(validateNativeHandshake(adapter(), { clientVersion: "2.1.258",
    handshake: handshake({ supported: false, modes: [], opaqueEndpointRef: null, leaseUntil: null,
      reasonCode: "client_session_embedded" }) }),
  { ok: false, reasonCode: "client_session_embedded", clientVersion: null,
    protocolContract: "fixture-native-v1", modes: [], opaqueEndpointRef: null, leaseUntil: null });
});

test("a refused handshake may name the launch option behind it, as an option token only", () => {
  const refused = patch => validateNativeHandshake(adapter(), { clientVersion: "2.1.258",
    handshake: handshake({ supported: false, modes: [], opaqueEndpointRef: null, leaseUntil: null,
      reasonCode: "client_session_embedded", ...patch }) });
  assert.deepEqual(refused({ launchOption: "--search" }),
    { ok: false, reasonCode: "client_session_embedded", clientVersion: null,
      protocolContract: "fixture-native-v1", modes: [], opaqueEndpointRef: null, leaseUntil: null,
      launchOption: "--search" });
  assert.equal(refused({ launchOption: "-c" }).launchOption, "-c");
  assert.equal(Object.hasOwn(refused({}), "launchOption"), false, "optional");
  // A vendor string, a value or a shell word is not an option token.
  for (const launchOption of ["search", "--config=model=o3", "--search; rm -rf /", "-", "--",
    "--Search", `--${"x".repeat(60)}`, null, 7]) {
    assert.throws(() => refused({ launchOption }), /launchOption/, String(launchOption));
  }
  // Only a refusal carries one: a working handshake has nothing to explain.
  assert.throws(() => validateNativeHandshake(adapter(), { clientVersion: "2.1.258",
    handshake: handshake({ launchOption: "--search" }) }), /launchOption/);
});
