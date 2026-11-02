import assert from "node:assert/strict";
import test from "node:test";

import { KIMI_WEB_PRODUCT_CASES, assertKimiWebRunEvidence, scenarioPasses }
  from "../../scripts/e2e/kimi-web-evidence.mjs";

const AT = "2026-10-30T18:00:00.000Z";
const messageId = "message_test";
const scenarios = Object.entries(KIMI_WEB_PRODUCT_CASES).map(([caseId, definition]) => ({
  caseId, outcome: "passed", startedAt: AT, finishedAt: AT, messageId,
  observations: Object.entries(definition.requires).map(([kind, outcome]) => ({ kind, outcome, at: AT })) }));
const run = { schemaVersion: 1, source: "real-client-capture", client: "kimi", phase: "product",
  clientVersion: "2.4.0", platform: "darwin-arm64", packageSha256: "a".repeat(64),
  startedAt: AT, finishedAt: AT, scenarioCount: 6, passedCount: 6, failedCount: 0,
  cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" },
  scenarios };

test("all six installed-product branches are required", () => {
  assert.deepEqual(scenarioPasses("C01", scenarios[0].observations), true);
  assert.deepEqual(scenarioPasses("C01", scenarios[0].observations.slice(1)), false);
  assert.doesNotThrow(() => assertKimiWebRunEvidence(run));
  assert.throws(() => assertKimiWebRunEvidence({ ...run, scenarios: scenarios.slice(1) }), /requires case C01/);
});

test("evidence rejects false passes, foreign fields, and transcript-shaped additions", () => {
  const falsePass = { ...scenarios[0], observations: scenarios[0].observations.slice(1) };
  assert.throws(() => assertKimiWebRunEvidence({ ...run, scenarios: [falsePass, ...scenarios.slice(1)] }),
    /outcome does not match/);
  assert.throws(() => assertKimiWebRunEvidence({ ...run, transcript: "private" }), /unknown field/);
  assert.throws(() => assertKimiWebRunEvidence({ ...run,
    scenarios: [{ ...scenarios[0], body: "private" }, ...scenarios.slice(1)] }), /unknown field/);
  assert.throws(() => assertKimiWebRunEvidence({ ...run,
    scenarios: [{ ...scenarios[0], observations: [...scenarios[0].observations,
      { kind: "body", outcome: "raw transcript", at: AT }] }, ...scenarios.slice(1)] }), /closed kind/);
});

test("cleanup and package identity cannot be omitted", () => {
  assert.throws(() => assertKimiWebRunEvidence({ ...run, packageSha256: "unknown" }), /SHA-256/);
  assert.throws(() => assertKimiWebRunEvidence({ ...run,
    cleanup: { ...run.cleanup, temporaryState: "kept" } }), /removed/);
});
