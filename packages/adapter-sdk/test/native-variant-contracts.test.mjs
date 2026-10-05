import assert from "node:assert/strict";
import test from "node:test";

import { defineAdapter } from "../src/capabilities.mjs";
import { evaluateNativeEligibility, evaluateVersionContract, validateNativeHandshake }
  from "../src/native-delivery.mjs";

// One adapter, two products, two delivery protocols: Antigravity CLI pushes
// through a relay from 1.2.7, Antigravity 2.0 through its language server from
// 2.19.1. Each protocol's first passing capture is its own floor, and a
// version from one product's line never meets the other's floor.
const noop = async () => ({ ok: true, changes: [], diagnostics: [] });
const livePush = (client, version) => ({
  client, version, platform: "darwin-arm64", observedAt: "2026-10-04T12:00:00.000Z",
  capability: "delivery.livePush", fixture: `fixtures/delivery/${client}-${version}.json`,
  provenance: "fixtures/certification-provenance.json", provenanceId: `${client}-${version}`,
  idleBehavior: "offered", busyBehavior: "queued_after_turn", authorityLevel: "experimental",
  limitations: ["fixture only"], result: "pass",
});
const manifest = (overrides = {}) => ({
  id: "fixture", displayName: "Fixture",
  client: { command: "fixture", certificationName: "fixture-cli", versionArgs: ["--version"],
    variants: [{ certificationName: "fixture-desktop", displayName: "Fixture Desktop" }] },
  capabilities: { delivery: { livePush: true } },
  certification: { evidence: [livePush("fixture-cli", "1.2.7"),
    livePush("fixture-desktop", "2.19.1")] },
  nativeDelivery: {
    minimum: "1.2.7",
    anchors: [{ version: "1.2.7", protocolContract: "fixture-relay-v1" },
      { version: "2.19.1", protocolContract: "fixture-desktop-v1", client: "fixture-desktop" }],
    knownBad: [{ version: "2.19.1", reasonCode: "known_bad_version" }],
    activationKinds: ["native-config"],
  },
  detect: noop, install: noop, uninstall: noop, doctor: noop,
  normalizeHook: () => ({ kind: "sessionStart", sessionId: "s", cwd: "/tmp" }),
  renderContext: () => "",
  offerMessage: async () => ({ accepted: true, transport: "fixture", clientVersion: "1.2.7" }),
  probeNativeDelivery: async () => null,
  planNativeActivation: async () => ({ eligible: false, reasonCode: "unsupported_shell", mechanisms: [] }),
  bindNativeSession: async () => null,
  ...overrides,
});
const handshake = (clientVersion, protocolContract) => ({
  supported: true, clientVersion, protocolContract, modes: ["livePush", "idleWake", "busyQueue"],
  opaqueEndpointRef: "endpoint", leaseUntil: "2026-10-04T12:01:00.000Z", reasonCode: null,
});
const probe = (clientVersion, protocolContract) => ({
  supported: true, clientVersion, protocolContract, executableFingerprint: null,
  modes: ["livePush", "idleWake"], reasonCode: null,
});

test("a handshake is judged against the floor of the protocol it reports", () => {
  const adapter = defineAdapter(manifest());
  const judge = (version, contract) => validateNativeHandshake(adapter,
    { clientVersion: version, handshake: handshake(version, contract) });

  assert.equal(judge("2.19.1", "fixture-desktop-v1").ok, true);
  assert.equal(judge("2.19.1", "fixture-desktop-v1").protocolContract, "fixture-desktop-v1");
  assert.equal(judge("2.18.9", "fixture-desktop-v1").reasonCode, "below_minimum_version");
  assert.equal(judge("1.2.16", "fixture-relay-v1").ok, true);
  assert.equal(judge("1.2.6", "fixture-relay-v1").reasonCode, "below_minimum_version");
  assert.equal(judge("2.20.0", "someone-elses-v1").reasonCode, "protocol_mismatch");
});

test("a CLI version cannot borrow the desktop protocol, nor the desktop the CLI's", () => {
  const adapter = defineAdapter(manifest());

  // 1.2.16 is past the CLI floor but far below the desktop one.
  assert.equal(validateNativeHandshake(adapter, { clientVersion: "1.2.16",
    handshake: handshake("1.2.16", "fixture-desktop-v1") }).reasonCode, "below_minimum_version");
});

test("the denylist names the primary product's versions only", () => {
  const adapter = defineAdapter(manifest());

  assert.equal(evaluateVersionContract(adapter, { clientVersion: "2.19.1" }).reasonCode,
    "known_bad_version");
  assert.equal(evaluateVersionContract(adapter, { clientVersion: "2.19.1",
    protocolContract: "fixture-desktop-v1" }).reasonCode, null);
});

test("the static rule names the floor of the protocol it was asked about", () => {
  const adapter = defineAdapter(manifest());

  assert.deepEqual(evaluateVersionContract(adapter, { clientVersion: "2.20.0",
    protocolContract: "fixture-desktop-v1" }), { reasonCode: null, minimumVersion: "2.19.1",
    protocolContract: "fixture-desktop-v1" });
  assert.deepEqual(evaluateVersionContract(adapter, { clientVersion: "1.3.0" }),
    { reasonCode: null, minimumVersion: "1.2.7", protocolContract: "fixture-relay-v1" });
  assert.equal(evaluateVersionContract(adapter, { clientVersion: "2.20.0",
    protocolContract: "unknown-v1" }).reasonCode, "protocol_mismatch");
});

test("eligibility follows the protocol the probe found", () => {
  const adapter = defineAdapter(manifest());

  assert.equal(evaluateNativeEligibility(adapter, { clientVersion: null,
    probe: probe("2.19.1", "fixture-desktop-v1") }).eligible, true);
  assert.equal(evaluateNativeEligibility(adapter, { clientVersion: null,
    probe: probe("2.0.0", "fixture-desktop-v1") }).reasonCode, "below_minimum_version");
});

test("an anchor for another product needs that product's own passing capture", () => {
  assert.throws(() => defineAdapter(manifest({ certification: { evidence: [
    livePush("fixture-cli", "1.2.7"), livePush("fixture-cli", "2.19.1")] } })),
  /anchor 2.19.1 has no passing delivery.livePush certification/);
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...manifest().nativeDelivery,
    anchors: [{ version: "1.2.7", protocolContract: "fixture-relay-v1" },
      { version: "2.19.1", protocolContract: "fixture-desktop-v1", client: "fixture-ide" }] } })),
  /anchor 2.19.1 names client fixture-ide, which the adapter does not declare/);
});

test("the minimum stays the primary product's first capture", () => {
  // A variant's line may start below the primary minimum; it is not "below
  // the minimum" for that, it is on another line.
  const lower = manifest({
    certification: { evidence: [livePush("fixture-cli", "1.2.7"), livePush("fixture-desktop", "0.9.0")] },
    nativeDelivery: { ...manifest().nativeDelivery,
      anchors: [{ version: "1.2.7", protocolContract: "fixture-relay-v1" },
        { version: "0.9.0", protocolContract: "fixture-desktop-v1", client: "fixture-desktop" }] },
  });
  assert.doesNotThrow(() => defineAdapter(lower));
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...manifest().nativeDelivery,
    minimum: "2.19.1",
    anchors: [{ version: "2.19.1", protocolContract: "fixture-desktop-v1", client: "fixture-desktop" }] } })),
  /minimum 2.19.1 must be the first passing capture/);
});

test("two products cannot share one protocol name", () => {
  assert.throws(() => defineAdapter(manifest({ nativeDelivery: { ...manifest().nativeDelivery,
    anchors: [{ version: "1.2.7", protocolContract: "fixture-relay-v1" },
      { version: "2.19.1", protocolContract: "fixture-relay-v1", client: "fixture-desktop" }] } })),
  /protocol fixture-relay-v1 is anchored for both fixture-cli and fixture-desktop/);
});
