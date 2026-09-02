import assert from "node:assert/strict";
import test from "node:test";

import { defineAdapter } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { LIVE_POLICIES, establishNativeBinding, livePolicyFrom } from "../src/native-binding.mjs";

const NOW = "2026-09-02T12:00:00.000Z";
const noop = async () => ({ ok: true, changes: [], diagnostics: [] });
const HANDSHAKE = {
  supported: true, clientVersion: "2.1.258", protocolContract: "fixture-native-v1",
  modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
  opaqueEndpointRef: "adapter-owned-endpoint-id", leaseUntil: "2026-09-02T12:01:00.000Z",
  reasonCode: null,
};

function nativeAdapter(bindNativeSession = async () => HANDSHAKE) {
  return defineAdapter({
    id: "fixture", displayName: "Fixture",
    client: { command: "fixture", certificationName: "fixture-client", versionArgs: ["--version"] },
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [{ client: "fixture-client", version: "2.1.258",
      platform: "darwin-arm64", observedAt: NOW, capability: "delivery.livePush",
      fixture: "fixtures/delivery/fixture-client-2.1.258.json",
      provenance: "fixtures/certification-provenance.json", provenanceId: "native",
      idleBehavior: "offered", busyBehavior: "queued_after_turn", authorityLevel: "experimental",
      limitations: ["fixture only"], result: "pass" }] },
    nativeDelivery: { minimumByPlatform: { "darwin-arm64": "2.1.258" },
      anchors: [{ platform: "darwin-arm64", version: "2.1.258", protocolContract: "fixture-native-v1" }],
      knownBad: [], activationKinds: ["shell-bootstrap"] },
    detect: noop, install: noop, uninstall: noop, doctor: noop,
    normalizeHook: () => ({ kind: "sessionStart", sessionId: "s", cwd: "/tmp" }),
    renderContext: () => "",
    offerMessage: async () => ({ accepted: true, transport: "fixture", clientVersion: "2.1.258" }),
    probeNativeDelivery: async () => ({ supported: true, clientVersion: "2.1.258",
      protocolContract: "fixture-native-v1", executableFingerprint: null, modes: ["livePush"],
      reasonCode: null }),
    planNativeActivation: async () => ({ eligible: false, reasonCode: "unsupported_shell",
      mechanisms: [] }),
    bindNativeSession,
  });
}

function fakeService({ publishError = null } = {}) {
  const calls = [];
  return { calls,
    async clearDeliveryBinding(input) { calls.push(["clear", input]); },
    async publishDeliveryBinding(input) {
      calls.push(["publish", input]);
      if (publishError) throw publishError;
      return input;
    } };
}

const hookBinding = { accSessionId: "session_a", generation: "generation_a", clientPid: 4242 };
const establish = (adapter, service, overrides = {}) => establishNativeBinding({
  adapter, event: { kind: "sessionStart", sessionId: "harness-1", cwd: "/tmp" }, hookBinding,
  clientVersion: "2.1.258", platform: "darwin-arm64", livePolicy: "actionable", service,
  runtimeDir: "/runtime", clock: { now: () => NOW }, timeoutMs: 50, ...overrides });

test("policy off clears the current binding and never handshakes", async () => {
  let handshakes = 0;
  const service = fakeService();
  const result = await establish(nativeAdapter(async () => { handshakes += 1; return HANDSHAKE; }),
    service, { livePolicy: "off" });
  assert.deepEqual(result, { state: "off", reasonCode: null, modes: [] });
  assert.deepEqual(service.calls, [["clear", { sessionId: "session_a", generation: "generation_a" }]]);
  assert.equal(handshakes, 0);
});

test("a missing, malformed, or foreign policy value is off", () => {
  assert.deepEqual(LIVE_POLICIES, ["off", "actionable", "all"]);
  for (const value of [undefined, "", "ALL", "1", "true", "actionable ", " off"]) {
    assert.equal(livePolicyFrom({ ACC_NATIVE_DELIVERY_POLICY: value }), "off", String(value));
  }
  assert.equal(livePolicyFrom({}), "off");
  assert.equal(livePolicyFrom(undefined), "off");
  assert.equal(livePolicyFrom({ ACC_NATIVE_DELIVERY_POLICY: "all" }), "all");
});

test("an adapter without a native contract is a no-op", async () => {
  const service = fakeService();
  const plain = { id: "plain", capabilities: { delivery: { livePush: false } } };
  assert.deepEqual(await establish(plain, service),
    { state: "unsupported", reasonCode: "native_delivery_unsupported", modes: [] });
  assert.deepEqual(service.calls, []);
});

test("a successful handshake publishes only adapter modes, an opaque ref, and a bounded lease",
  async () => {
    const service = fakeService();
    const result = await establish(nativeAdapter(), service, { livePolicy: "all" });
    assert.deepEqual(result, { state: "active", reasonCode: null,
      modes: ["livePush", "idleWake", "busyQueue", "replyRoute"] });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(service.calls, [
      ["clear", { sessionId: "session_a", generation: "generation_a" }],
      ["publish", { sessionId: "session_a", generation: "generation_a", adapterId: "fixture",
        clientVersion: "2.1.258", availableModes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
        livePolicy: "all", opaqueEndpointRef: "adapter-owned-endpoint-id",
        leaseUntil: "2026-09-02T12:01:00.000Z" }],
    ]);
    assert.equal(JSON.stringify(result).includes("adapter-owned-endpoint-id"), false);
  });

test("a lease longer than twice the heartbeat cadence is clamped; a past lease is refused",
  async () => {
    const service = fakeService();
    await establish(nativeAdapter(async () => ({ ...HANDSHAKE, leaseUntil: "2026-09-03T00:00:00.000Z" })),
      service);
    assert.equal(service.calls.at(-1)[1].leaseUntil, "2026-09-02T12:02:00.000Z");
    const stale = fakeService();
    const result = await establish(nativeAdapter(async () => ({ ...HANDSHAKE,
      leaseUntil: "2026-09-02T11:59:00.000Z" })), stale);
    assert.deepEqual(result, { state: "degraded", reasonCode: "handshake_failed", modes: [] });
    assert.equal(stale.calls.some(([name]) => name === "publish"), false);
  });

test("every failure clears the old binding, publishes nothing, and returns a closed reason",
  async () => {
    const cases = [
      [async () => new Promise(() => {}), "handshake_timeout", "degraded"],
      [async () => { throw new Error("socket path /secret/endpoint.sock refused"); },
        "handshake_failed", "degraded"],
      [async () => ({ ...HANDSHAKE, supported: false, modes: [], opaqueEndpointRef: null,
        leaseUntil: null, reasonCode: "handshake_timeout" }), "handshake_timeout", "degraded"],
      [async () => ({ ...HANDSHAKE, clientVersion: "2.1.259" }), "handshake_version_mismatch",
        "degraded"],
      [async () => ({ ...HANDSHAKE, protocolContract: "fixture-native-v2" }), "protocol_mismatch",
        "degraded"],
      [async () => ({ ...HANDSHAKE, transcript: "x" }), "handshake_failed", "degraded"],
    ];
    for (const [bind, reasonCode, state] of cases) {
      const service = fakeService();
      const result = await establish(nativeAdapter(bind), service);
      assert.deepEqual(result, { state, reasonCode, modes: [] }, reasonCode);
      assert.equal(service.calls.some(([name]) => name === "publish"), false, reasonCode);
      assert.equal(service.calls[0][0], "clear", reasonCode);
      assert.equal(JSON.stringify(result).includes("secret"), false);
    }
  });

test("a stale generation at publish time is reported, and the old binding is cleared", async () => {
  const service = fakeService({ publishError: new AccError(EXIT.CONFLICT, "stale") });
  const result = await establish(nativeAdapter(), service);
  assert.deepEqual(result, { state: "degraded", reasonCode: "session_generation_stale", modes: [] });
  assert.deepEqual(service.calls.map(([name]) => name), ["clear", "publish", "clear"]);
});

test("a client the static rule refuses is unsupported, not retried as degraded", async () => {
  const service = fakeService();
  const older = await establish(nativeAdapter(), service, { clientVersion: "2.1.100" });
  assert.deepEqual(older, { state: "unsupported", reasonCode: "below_minimum_version", modes: [] });
  const elsewhere = await establish(nativeAdapter(), service, { platform: "linux-x64" });
  assert.equal(elsewhere.reasonCode, "platform_not_captured");
});

test("a binding without a resolved client process cannot go live until a fresh start", async () => {
  const service = fakeService();
  const result = await establish(nativeAdapter(), service,
    { hookBinding: { accSessionId: "session_a", generation: "generation_a" } });
  assert.deepEqual(result, { state: "degraded", reasonCode: "client_process_unknown", modes: [] });
  assert.deepEqual(service.calls, [["clear", { sessionId: "session_a", generation: "generation_a" }]]);
});
