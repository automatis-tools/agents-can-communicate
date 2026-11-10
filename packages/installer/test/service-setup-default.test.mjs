import assert from "node:assert/strict";
import test from "node:test";

import { applyServiceSetup } from "../src/service-setup.mjs";

const adapter = { displayName: "Codex CLI", prepareNativeServiceSetup: async () => ({
  state: "failed", started: false, reasonCode: "daemon_start_failed",
  diagnostic: "could not start the service" }) };
const operationFrom = source => ({ adapterId: "codex", livePolicy: "actionable",
  deliveryDecision: { source, completeSetup: true }, nativeServiceSetup: { state: "needed" },
  summary: [], diagnostics: [], needsAction: [] });

test("a service the default could not start leaves the install successful and says so", async () => {
  const operation = operationFrom("default-enabled");
  const results = { failed: [] };

  await applyServiceSetup({ adapter, context: {}, operation, results });

  assert.deepEqual(results.failed, []);
  assert.deepEqual(operation.needsAction, ["could not start the service"]);
  assert.equal(operation.nativeServiceSetup.state, "failed");
});

test("a service someone asked for by option still fails the install", async () => {
  const operation = operationFrom("explicit-option");
  const results = { failed: [] };

  await applyServiceSetup({ adapter, context: {}, operation, results });

  assert.equal(results.failed.length, 1);
  assert.equal(results.failed[0].stage, "service-setup");
});
