import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { defineAdapter } from "../src/capabilities.mjs";
import { NATIVE_ACTIVATION_KINDS, NATIVE_BINDING_MODES, compareStableVersions,
  evaluateNativeEligibility, validateNativeActivationPlan, validateNativeDeliveryContract,
  validateNativeHandshake } from "../src/native-delivery.mjs";

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
  minimumByPlatform: { "darwin-arm64": "2.1.258" },
  anchors: [{ platform: "darwin-arm64", version: "2.1.258", protocolContract: "fixture-native-v1" }],
  knownBad: [{ from: "2.1.300", to: "2.1.302", reasonCode: "known_bad_version" },
    { version: "2.1.310", reasonCode: "known_bad_version" }],
  activationKinds: ["shell-bootstrap"],
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
  { clientVersion, platform: "darwin-arm64", probe: probe({ clientVersion }), ...options });
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

test("older, prerelease, known-bad, and uncaptured clients fail closed with a reason", () => {
  const closed = (reasonCode, extra = {}) => ({ eligible: false, reasonCode,
    minimumVersion: "2.1.258", protocolContract: "fixture-native-v1", modes: [], ...extra });
  assert.deepEqual(evaluate("2.1.257"), closed("below_minimum_version"));
  assert.deepEqual(evaluate("2.2.0-beta.1"), closed("prerelease_not_captured"));
  assert.deepEqual(evaluate("2.1.301"), closed("known_bad_version"));
  assert.deepEqual(evaluate("2.1.300"), closed("known_bad_version"));
  assert.deepEqual(evaluate("2.1.302"), closed("known_bad_version"));
  assert.deepEqual(evaluate("2.1.310"), closed("known_bad_version"));
  assert.deepEqual(evaluate("2.1.303"), ELIGIBLE);
  assert.deepEqual(evaluate(undefined), closed("version_unavailable"));
  assert.deepEqual(evaluate("2.1.258", { platform: "linux-x64" }),
    closed("platform_not_captured", { minimumVersion: null, protocolContract: null }));
});

test("unsupported, timed-out, mismatched, and wrong-protocol probes fail closed", () => {
  const closed = reasonCode => ({ eligible: false, reasonCode, minimumVersion: "2.1.258",
    protocolContract: "fixture-native-v1", modes: [] });
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ supported: false, modes: [],
    reasonCode: "feature_probe_failed" }) }), closed("feature_probe_failed"));
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ supported: false, modes: [],
    reasonCode: "probe_timeout", clientVersion: null }) }), closed("probe_timeout"));
  assert.deepEqual(evaluate("2.1.258", { probe: null }), closed("feature_probe_failed"));
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ clientVersion: "2.1.259" }) }),
    closed("probe_version_mismatch"));
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ protocolContract: "fixture-native-v2" }) }),
    closed("protocol_mismatch"));
  assert.deepEqual(evaluate("2.1.258", { probe: probe({ modes: ["idleWake"] }) }),
    closed("feature_probe_failed"));
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
  assert.equal(Object.isFrozen(contract.minimumByPlatform), true);
  assert.equal(Object.isFrozen(contract.knownBad[0]), true);
  assert.equal(Object.isFrozen(contract.activationKinds), true);
});

test("unknown manifest and probe keys are rejected", () => {
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery, maximum: "9.9.9" } })),
    /unknown nativeDelivery field maximum/);
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery,
    anchors: [{ ...nativeDelivery.anchors[0], captured: true }] } })), /unknown .*anchor.* captured/);
  assert.throws(() => evaluate("2.1.258", { probe: probe({ transcript: "x" }) }),
    /unknown .*probe.* transcript/);
  assert.throws(() => evaluate("2.1.258", { probe: probe({ executableFingerprint: "md5:abc" }) }),
    /executableFingerprint/);
});

test("every anchor needs passing livePush certification for the same client, version, and platform",
  () => {
    assert.throws(() => defineAdapter(manifest({ certification: { evidence: [] } })),
      /anchor .*2\.1\.258.*darwin-arm64.* passing delivery\.livePush/);
    assert.throws(() => defineAdapter(manifest({ certification: { evidence: [
      livePushEvidence("2.1.258", "linux-x64")] } })), /passing delivery\.livePush/);
    assert.throws(() => defineAdapter(manifest({ certification: { evidence: [
      { ...livePushEvidence(), result: "fail" }] } })), /passing delivery\.livePush/);
    assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery,
      minimumByPlatform: { "darwin-arm64": "2.1.250" } } })), /minimum .*first passing capture/);
    assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery,
      minimumByPlatform: { "darwin-arm64": "2.1.258", "linux-x64": "2.1.258" } } })),
    /linux-x64 .*anchor/);
  });

test("the static contract is closed in every field", () => {
  const bad = patch => () => defineAdapter(manifest({ nativeDelivery: { ...nativeDelivery, ...patch } }));
  assert.throws(bad({ activationKinds: ["shell-bootstrap", "telepathy"] }), /activationKinds/);
  assert.throws(bad({ activationKinds: [] }), /activationKinds/);
  assert.throws(bad({ activationKinds: ["shell-bootstrap", "shell-bootstrap"] }), /activationKinds/);
  assert.throws(bad({ minimumByPlatform: { "darwin-arm64": "2.1" } }), /minimumByPlatform/);
  assert.throws(bad({ minimumByPlatform: { "solaris-sparc": "2.1.258" } }), /minimumByPlatform/);
  assert.throws(bad({ minimumByPlatform: {} }), /minimumByPlatform/);
  assert.throws(bad({ knownBad: [{ from: "2.1.302", to: "2.1.300", reasonCode: "known_bad_version" }] }),
    /knownBad/);
  assert.throws(bad({ knownBad: [{ version: "2.1.310", reasonCode: "broken" }] }), /knownBad/);
  assert.throws(bad({ anchors: [] }), /anchors/);
  assert.throws(bad({ anchors: [{ platform: "darwin-arm64", version: "2.1.258",
    protocolContract: "Fixture Native" }] }), /protocolContract/);
  assert.deepEqual(NATIVE_ACTIVATION_KINDS, ["shell-bootstrap", "native-config", "native-service"]);
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
    platform: "darwin-arm64", probe: probe() }), { eligible: false,
    reasonCode: "native_delivery_unsupported", minimumVersion: null, protocolContract: null,
    modes: [] });
});

test("the session handshake rechecks the static rule and publishes only adapter facts", () => {
  const ok = validateNativeHandshake(adapter(), { clientVersion: "2.1.259", platform: "darwin-arm64",
    handshake: handshake({ clientVersion: "2.1.259" }) });
  assert.deepEqual(ok, { ok: true, reasonCode: null, protocolContract: "fixture-native-v1",
    modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
    opaqueEndpointRef: "adapter-owned-endpoint-id", leaseUntil: "2026-09-02T12:01:00.000Z" });
  assert.equal(Object.isFrozen(ok), true);
  const closed = reasonCode => ({ ok: false, reasonCode, protocolContract: "fixture-native-v1",
    modes: [], opaqueEndpointRef: null, leaseUntil: null });
  const check = (clientVersion, patch, platform = "darwin-arm64") => validateNativeHandshake(adapter(),
    { clientVersion, platform, handshake: handshake({ clientVersion, ...patch }) });
  assert.deepEqual(check("2.1.257", {}), closed("below_minimum_version"));
  assert.deepEqual(check("2.1.301", {}), closed("known_bad_version"));
  assert.deepEqual(check("2.1.258", { supported: false, modes: [], opaqueEndpointRef: null,
    leaseUntil: null, reasonCode: "handshake_timeout" }), closed("handshake_timeout"));
  assert.deepEqual(check("2.1.258", { clientVersion: "2.1.260" }), closed("handshake_version_mismatch"));
  assert.deepEqual(check("2.1.258", { protocolContract: "fixture-native-v2" }), closed("protocol_mismatch"));
  assert.deepEqual(check("2.1.258", { modes: ["idleWake"] }), closed("handshake_failed"));
  assert.deepEqual(check("2.1.258", {}, "linux-x64"), { ...closed("platform_not_captured"),
    protocolContract: null });
  assert.throws(() => check("2.1.258", { executableFingerprint: `sha256:${"a".repeat(64)}` }),
    /unknown .*handshake.* executableFingerprint/);
  assert.throws(() => check("2.1.258", { opaqueEndpointRef: "" }), /opaqueEndpointRef/);
  assert.throws(() => check("2.1.258", { leaseUntil: "soon" }), /leaseUntil/);
});

test("an activation plan is closed, frozen, and never shell source", () => {
  const plan = validateNativeActivationPlan({ eligible: true, reasonCode: null, mechanisms: [
    { kind: "shell-bootstrap", command: "claude", realExecutable: "/abs/vendor/bin/claude",
      prefixArgs: ["--captured-vendor-flag", "captured-value"] },
    { kind: "native-config", artifactIds: ["adapter-owned-config-block"] },
    { kind: "native-service", serviceId: "vendor-daemon", preExisting: false,
      applyCommand: { executable: "/abs/vendor/bin/client", args: ["vendor", "bootstrap"] },
      teardownCommand: null },
  ] });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.mechanisms[0].prefixArgs), true);
  assert.equal(Object.isFrozen(plan.mechanisms[2].applyCommand), true);
  const bad = value => () => validateNativeActivationPlan(value);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [], shell: "sh" }), /unknown .*plan/);
  assert.throws(bad({ eligible: false, reasonCode: "unsupported_shell", mechanisms: [
    { kind: "native-config", artifactIds: ["x"] }] }), /ineligible/);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [{ kind: "shell-bootstrap",
    command: "claude", realExecutable: "vendor/bin/claude", prefixArgs: [] }] }), /realExecutable/);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [{ kind: "shell-bootstrap",
    command: "claude", realExecutable: "/abs/claude", prefixArgs: ["--flag; rm -rf /"] }] }),
  /prefixArgs/);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [{ kind: "shell-bootstrap",
    command: "claude && evil", realExecutable: "/abs/claude", prefixArgs: [] }] }), /command/);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [{ kind: "native-service",
    serviceId: "d", preExisting: false, applyCommand: "codex app-server daemon start",
    teardownCommand: null }] }), /applyCommand/);
  assert.throws(bad({ eligible: true, reasonCode: null, mechanisms: [{ kind: "launchd" }] }), /kind/);
  assert.deepEqual(validateNativeActivationPlan({ eligible: false, reasonCode: "unsupported_shell",
    mechanisms: [] }), { eligible: false, reasonCode: "unsupported_shell", mechanisms: [] });
});
