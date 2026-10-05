import assert from "node:assert/strict";
import test from "node:test";

import * as sdk from "../src/index.mjs";

// A vendor's desktop app can run the same hooks as its CLI under its own
// version line: Antigravity 2.19.1 beside Antigravity CLI 1.2.16. Evidence
// captured on one says nothing about the other's versions.
const noop = async () => ({ ok: true, changes: [], diagnostics: [] });

const base = (overrides = {}) => ({
  id: "example",
  displayName: "Example",
  client: { command: "example", certificationName: "example-cli",
    variants: [{ certificationName: "example-desktop", displayName: "Example Desktop" }] },
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

const row = (overrides = {}) => ({
  client: "example-cli",
  version: "1.2.0",
  platform: "darwin-arm64",
  observedAt: "2026-10-04",
  capability: "delivery.nextTurn",
  fixture: "fixtures/next-turn.json",
  provenance: "fixtures/certification-provenance.json",
  provenanceId: "next-turn",
  idleBehavior: "offered at the next invocation",
  busyBehavior: "does not interrupt",
  authorityLevel: "context",
  limitations: ["captured once"],
  result: "pass",
  ...overrides,
});

const adapterWith = evidence => sdk.defineAdapter(base({
  capabilities: { delivery: { nextTurn: true } },
  certification: { evidence },
  renderContextResult: () => ({}),
}));

const facts = (clientVersion, clientName) => ({ clientVersion, platform: "darwin-arm64",
  ...(clientName === undefined ? {} : { clientName }) });

test("a variant is judged by its own evidence, not by the primary client's", () => {
  const adapter = adapterWith([row(), row({ client: "example-desktop", version: "2.19.1",
    provenanceId: "next-turn-desktop" })]);

  assert.deepEqual(sdk.capabilityEvidence(adapter, facts("2.19.1", "example-desktop"),
    "delivery.nextTurn"), { granted: true, reason: null, version: "2.19.1" });
  // 2.5.0 is newer than every CLI row; as a desktop version it predates the
  // only desktop capture, and the CLI rows must not stand in for it.
  assert.deepEqual(sdk.capabilityEvidence(adapter, facts("2.5.0", "example-desktop"),
    "delivery.nextTurn"), { granted: false, reason: "older-than-evidence", version: "2.19.1" });
  assert.deepEqual(sdk.capabilityEvidence(adapter, facts("2.5.0"), "delivery.nextTurn"),
    { granted: true, reason: null, version: "1.2.0" });
});

test("a variant with no evidence of its own has nothing certified", () => {
  const adapter = adapterWith([row()]);

  assert.deepEqual(sdk.capabilityEvidence(adapter, facts("2.19.1", "example-desktop"),
    "delivery.nextTurn"), { granted: false, reason: "unobserved", version: null });
  assert.equal(sdk.effectiveCapabilities(adapter, facts("2.19.1", "example-desktop"))
    .delivery.nextTurn, false);
  assert.equal(sdk.effectiveCapabilities(adapter, facts("2.19.1")).delivery.nextTurn, true);
});

test("a client name the adapter does not declare inherits nothing", () => {
  const adapter = adapterWith([row()]);

  assert.deepEqual(sdk.capabilityEvidence(adapter, facts("1.2.0", "someone-else"),
    "delivery.nextTurn"), { granted: false, reason: "unobserved", version: null });
});

test("evidence may name a declared variant and nothing else", () => {
  assert.doesNotThrow(() => adapterWith([row(), row({ client: "example-desktop",
    provenanceId: "desktop" })]));
  assert.throws(() => adapterWith([row(), row({ client: "example-ide", provenanceId: "ide" })]),
    /certification evidence client example-ide does not match/);
});

test("a declared capability still needs passing evidence of the primary client", () => {
  assert.throws(() => adapterWith([row({ client: "example-desktop" })]),
    /requires passing evidence/);
});

test("variants are a closed list of named products", () => {
  const withVariants = variants => () => sdk.defineAdapter(base({
    client: { command: "example", certificationName: "example-cli", variants } }));

  assert.doesNotThrow(withVariants([]));
  assert.throws(withVariants("example-desktop"), /client.variants must be an array/);
  assert.throws(withVariants([{ certificationName: "example-desktop" }]), /displayName/);
  assert.throws(withVariants([{ certificationName: "", displayName: "X" }]), /certificationName/);
  assert.throws(withVariants([{ certificationName: "example-cli", displayName: "X" }]),
    /repeats/);
  assert.throws(withVariants([{ certificationName: "example-desktop", displayName: "A" },
    { certificationName: "example-desktop", displayName: "B" }]), /repeats/);
  assert.throws(withVariants([{ certificationName: "example-desktop", displayName: "X",
    command: "x" }]), /unknown/);
});

test("the client identity methods are optional functions", () => {
  assert.doesNotThrow(() => sdk.defineAdapter(base({ identifyClientProcess: () => null,
    clientVersionOf: async () => null })));
  assert.throws(() => sdk.defineAdapter(base({ identifyClientProcess: "agy" })),
    /identifyClientProcess must be a function/);
  assert.throws(() => sdk.defineAdapter(base({ clientVersionOf: {} })),
    /clientVersionOf must be a function/);
});
