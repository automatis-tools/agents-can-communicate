import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verifyCertificationFixtureAllowlist } from "../scripts/package-certification.mjs";
import { matrixEvidence } from "./helpers/codex-local-daemon-evidence.mjs";

const ROOT = "node_modules/@agents-can-communicate/adapter-codex";
const CERTIFICATION = `${ROOT}/certification.json`;
const PROVENANCE = `${ROOT}/fixtures/certification-provenance.json`;
const CAPTURE = `${ROOT}/fixtures/delivery/codex-cli-0.152.1.json`;
const PRODUCT = `${ROOT}/fixtures/delivery/codex-cli-0.152.1-product.json`;
const HISTORICAL = `${ROOT}/fixtures/delivery/codex-cli-0.152.1-remote-workspace.json`;
const SHA256 = value => createHash("sha256").update(value).digest("hex");

function installedPackage(options = {}) {
  const product = options.product ?? matrixEvidence();
  const identity = { client: "codex-cli", version: "0.152.1", platform: "darwin-arm64",
    observedAt: "2026-09-08T12:00:00.000Z" };
  const defaultCapture = { ...identity, capability: "native_delivery", result: "pass",
    fixture: "codex-cli-0.152.1", launchMode: "ordinary-command-with-installed-hooks",
    protocolContract: "codex-app-server-thread-queue-v1", idle: "offered",
    busy: "queued_after_turn", reply: "routed", duplicate: "same_message_id",
    fallback: "queued", packageSha256: "a".repeat(64), limitations: ["unit fixture"] };
  const capture = options.captureValue ?? { ...defaultCapture, ...options.capture };
  const historical = { result: "fail", fixture: "remote-workspace" };
  const sources = new Map([
    [CAPTURE, JSON.stringify(capture)],
    [PRODUCT, options.productSource ?? JSON.stringify(product)],
    [HISTORICAL, JSON.stringify(historical)],
  ]);
  const record = { id: "native-delivery-0-152-1", ...identity,
    fixture: "fixtures/delivery/codex-cli-0.152.1.json",
    sha256: SHA256(sources.get(CAPTURE)), event: null, tool: null,
    claims: [{ capability: "delivery.livePush", result: "pass" }],
    productEvidence: { fixture: "fixtures/delivery/codex-cli-0.152.1-product.json",
      sha256: SHA256(sources.get(PRODUCT)) },
    historicalFixtures: [{
      fixture: "fixtures/delivery/codex-cli-0.152.1-remote-workspace.json",
      sha256: SHA256(sources.get(HISTORICAL)),
    }], ...options.record };
  const provenance = { schemaVersion: 1, captures: [
    ...(options.otherRecords ?? []), record] };
  const certification = { evidence: [{ ...identity, capability: "delivery.livePush",
    fixture: record.fixture, provenance: "fixtures/certification-provenance.json",
    provenanceId: record.id, result: "pass", ...options.evidence }] };
  sources.set(CERTIFICATION, JSON.stringify(certification));
  sources.set(PROVENANCE, JSON.stringify(provenance));
  const listed = [CERTIFICATION, CAPTURE, PROVENANCE, HISTORICAL];
  if (options.includeProduct !== false) listed.push(PRODUCT);
  for (const entry of options.extraListed ?? []) listed.push(entry);
  return {
    listed,
    readJson: async entry => JSON.parse(sources.get(entry)),
    readBytes: async entry => Buffer.from(sources.get(entry) ?? ""),
  };
}

const verify = fixture => verifyCertificationFixtureAllowlist(
  fixture.listed, fixture.readJson, fixture.readBytes);

test("packed adapter fixtures are an exact allowlist of certification references", async () => {
  const certification = { evidence: [{ fixture: "fixtures/SessionStart.json",
    provenance: "fixtures/certification-provenance.json", provenanceId: "session-start" }] };
  const provenance = { captures: [{ id: "session-start", fixture: "fixtures/SessionStart.json" }] };
  const base = [CERTIFICATION, `${ROOT}/fixtures/SessionStart.json`, PROVENANCE];
  const readJson = async entry => entry === CERTIFICATION ? certification : provenance;

  await assert.doesNotReject(verifyCertificationFixtureAllowlist(base, readJson));
  await assert.rejects(verifyCertificationFixtureAllowlist([
    ...base, `${ROOT}/fixtures/documentation-example.json`,
  ], readJson), /unreferenced certification fixture/);
  await assert.rejects(verifyCertificationFixtureAllowlist(base.filter(entry =>
    !entry.endsWith("SessionStart.json")), readJson), /certification fixture is missing/);
});

test("an installed-hooks pass ships hashed product and historical evidence", async () => {
  const fixture = installedPackage();
  const result = await verify(fixture);
  assert.deepEqual([...result.allowed].sort(), fixture.listed.filter(entry =>
    entry.includes("/fixtures/")).sort());
});

test("an installed-hooks pass requires its selected provenance product evidence", async () => {
  const fixture = installedPackage({ record: { productEvidence: undefined } });
  await assert.rejects(verify(fixture), /installed-hook pass requires product evidence/);
});

test("a passing Codex livePush claim cannot let malformed capture bytes opt out", async () => {
  const validCapture = await installedPackage().readJson(CAPTURE);
  const missingCapability = { ...validCapture };
  delete missingCapability.capability;
  for (const [captureValue, expected] of [
    [{}, /capture client differs from selected claim/],
    [missingCapability, /capture requires capability/],
    [{ ...validCapture, capability: "transport-only" },
      /capture capability is native_delivery/],
    [{ ...validCapture, result: "fail" },
      /capture result differs from selected claim/],
    [{ ...validCapture, launchMode: "ordinary-command-with-install-time-bootstrap" },
      /installed Codex livePush capture uses installed hooks/],
  ]) {
    await assert.rejects(verify(installedPackage({ captureValue })), expected);
  }
});

test("a passing manifest claim requires one matching selected provenance claim", async () => {
  for (const claims of [undefined, [
    { capability: "delivery.livePush", result: "pass" },
    { capability: "delivery.livePush", result: "pass" },
  ]]) {
    const fixture = installedPackage({ record: { claims } });
    await assert.rejects(verify(fixture), /does not select one provenance claim/);
  }
  const failed = installedPackage({ record: { claims: [
    { capability: "delivery.livePush", result: "fail" }] } });
  await assert.rejects(verify(failed), /result differs from selected provenance claim/);
});

test("only the manifest-selected provenance record contributes package references", async () => {
  const fixture = installedPackage({ otherRecords: [{ id: "not-selected",
    productEvidence: { fixture: "../../private.json", sha256: "bad" } }] });
  await assert.doesNotReject(verify(fixture));
});

test("associated evidence paths are normalized package-local JSON fixtures", async () => {
  for (const reference of ["/fixtures/product.json", "fixtures/../product.json",
    "fixtures\\product.json", "fixtures/product.txt", "fixtures//product.json"]) {
    const fixture = installedPackage({ record: { productEvidence: {
      fixture: reference, sha256: "a".repeat(64) } } });
    await assert.rejects(verify(fixture), /invalid productEvidence fixture/);
  }
  const historical = installedPackage({ record: { historicalFixtures: [{
    fixture: "fixtures/../private.json", sha256: "a".repeat(64) }] } });
  await assert.rejects(verify(historical), /invalid historicalFixtures 0 fixture/);
  const extraField = installedPackage({ record: { productEvidence: {
    fixture: "fixtures/delivery/codex-cli-0.152.1-product.json",
    sha256: "a".repeat(64), sourcePath: "/private/capture.json" } } });
  await assert.rejects(verify(extraField), /invalid productEvidence/);
});

test("associated evidence must be listed and match its raw byte digest", async () => {
  await assert.rejects(verify(installedPackage({ includeProduct: false })),
    /certification fixture is missing/);
  await assert.rejects(verify(installedPackage({ record: { productEvidence: {
    fixture: "fixtures/delivery/codex-cli-0.152.1-product.json",
    sha256: "b".repeat(64) } } })), /productEvidence digest differs/);
  await assert.rejects(verify(installedPackage({ record: { historicalFixtures: [{
    fixture: "fixtures/delivery/codex-cli-0.152.1-remote-workspace.json",
    sha256: "b".repeat(64) }] } })), /historicalFixtures 0 digest differs/);
});

test("empty, synthetic, transport-only, and mismatched product matrices fail", async () => {
  await assert.rejects(verify(installedPackage({ productSource: "" })),
    /productEvidence is not valid JSON/);
  await assert.rejects(verify(installedPackage({
    product: matrixEvidence("product", { source: "synthetic-unit-fixture" }) })),
  /real-client product evidence/);
  await assert.rejects(verify(installedPackage({ product: matrixEvidence("transport") })),
    /product-phase evidence/);
  const mismatchedProduct = matrixEvidence();
  mismatchedProduct.clientVersion = "0.153.4";
  mismatchedProduct.scenarios = mismatchedProduct.scenarios.map(scenario =>
    ({ ...scenario, clientVersion: "0.153.4" }));
  await assert.rejects(verify(installedPackage({ product: mismatchedProduct })),
    /client version matches product evidence/);
});

test("installed evidence identity matches the selected provenance record", async () => {
  for (const [key, value] of [["client", "other-client"], ["version", "0.153.4"],
    ["platform", "linux-x64"], ["observedAt", "2026-09-08T13:00:00.000Z"],
    ["fixture", "fixtures/delivery/other.json"]]) {
    const fixture = installedPackage({ evidence: { [key]: value },
      extraListed: key === "fixture" ? [`${ROOT}/${value}`] : [] });
    await assert.rejects(verify(fixture), new RegExp(`${key} differs from selected provenance`));
  }
  for (const [key, value] of [["client", "other-client"], ["version", "0.153.4"],
    ["platform", "linux-x64"], ["observedAt", "2026-09-08T13:00:00.000Z"]]) {
    const fixture = installedPackage({ capture: { [key]: value } });
    await assert.rejects(verify(fixture), new RegExp(`capture ${key} differs from selected claim`));
  }
});
