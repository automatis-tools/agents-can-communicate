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

test("delivery uses only the communication-first vocabulary", () => {
  assert.deepEqual(sdk.CAPABILITY_SHAPE.delivery, ["nextTurn", "livePush", "replyRoute"]);
  assert.equal(Object.hasOwn(sdk.CAPABILITY_SHAPE, "execution"), false);
});
