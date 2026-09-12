import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPlan } from "../src/apply.mjs";
import { loadOwnership } from "../src/ownership.mjs";
import { planInstallation } from "../src/plan.mjs";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-service-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [], file = path.join(home, "owned"), context = { home };
  const dataHome = path.join(home, "data");
  const adapter = { id: "service_fixture", displayName: "Service Fixture", capabilities: {},
    planInstall: () => [{ path: file }],
    async install() { calls.push("install"); await writeFile(file, "installed");
      return { needsAction: ["Review client hooks"] }; },
    async prepareNativeServiceSetup() { calls.push("prepare");
      const saved = (await loadOwnership({ dataHome })).installs[0];
      assert.equal(saved.deliveryPolicy, "actionable");
      assert.equal(saved.deliveryDecision.completeSetup, true);
      return { state: "failed", started: true, reasonCode: "daemon_start_failed", diagnostic: "Service start failed; retry install" }; } };
  const detected = [{ adapterId: adapter.id, displayName: adapter.displayName, present: true,
    nativeDelivery: { state: "degraded", reasonCode: "native_endpoint_unavailable" },
    nativeServiceSetup: { state: "needed", reasonCode: "native_endpoint_unavailable", diagnostic: "Prepare missing service" },
    deliveryDiagnostic: "Missing service", nativeSetup: "Start service manually" }];
  const args = { adapters: [adapter], detected, context, allowServiceSetup: true,
    deliveryByAdapter: { service_fixture: "actionable" },
    deliveryDecisionByAdapter: { service_fixture: { source: "explicit-option", completeSetup: true } } };
  return { adapter, context, calls, file, args, dataHome };
}

test("setup failure preserves installed files and consent before preparing, and other adapters continue", async t => {
  const f = await fixture(t);
  const plan = planInstallation(f.args);
  assert.equal(plan.operations[0].nativeServiceSetup?.state, "needed");
  const second = { ...f.adapter, id: "z_second", install: async () => ({}) };
  plan.operations.push({ ...plan.operations[0], adapterId: second.id, nativeServiceSetup: undefined });
  const result = await applyPlan({ ...f, plan, adapters: [f.adapter, second] });
  assert.equal(result.operations[0].applied, true);
  assert.equal(result.operations[1].applied, true);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reasonCode, "daemon_start_failed");
  assert.equal(await readFile(f.file, "utf8"), "installed");
  const saved = (await loadOwnership(f)).installs.find(i => i.adapterId === f.adapter.id);
  assert.equal(saved.deliveryPolicy, "actionable");
  assert.equal(saved.deliveryDecision.completeSetup, true);
  assert.deepEqual(f.calls, ["install", "prepare"]);
  assert.match(result.operations[0].needsAction.join(" "), /Review client hooks.*retry install/);
});

for (const mode of ["off", "no-consent", "refresh", "dry-run"]) {
  test(`${mode} never prepares a native service`, async t => {
    const f = await fixture(t);
    if (mode === "off") f.args.deliveryByAdapter.service_fixture = "off";
    if (mode === "no-consent") f.args.deliveryDecisionByAdapter.service_fixture.completeSetup = false;
    if (mode === "refresh") delete f.args.allowServiceSetup;
    const plan = planInstallation(f.args);
    assert.equal(Boolean(plan.operations[0].nativeServiceSetup), mode === "dry-run");
    await applyPlan({ ...f, plan, adapters: [f.adapter], dryRun: mode === "dry-run" });
    assert.deepEqual(f.calls, mode === "dry-run" ? [] : ["install"]);
  });
}

test("verified setup replaces stale missing-service output with session-needed output", async t => {
  const f = await fixture(t);
  f.adapter.prepareNativeServiceSetup = async () => ({ state: "ready", started: true,
    reasonCode: "native_session_unavailable", diagnostic: "Service ready; open a new session" });
  const result = await applyPlan({ ...f, plan: planInstallation(f.args), adapters: [f.adapter] });
  const operation = result.operations[0];
  assert.match(operation.deliverySummary, /Service ready.*new session/);
  assert.doesNotMatch(JSON.stringify(operation), /Missing service|Start service manually/);
  assert.equal(result.failed.length, 0);
});

test("blocked prerequisite becomes needsAction without losing adapter installation", async t => {
  const f = await fixture(t);
  f.args.detected[0].nativeServiceSetup = { state: "blocked", reasonCode: "missing_install", diagnostic: "Install vendor prerequisite" };
  const result = await applyPlan({ ...f, plan: planInstallation(f.args), adapters: [f.adapter] });
  assert.equal(result.operations[0].applied, true);
  assert.match(result.operations[0].needsAction.join(" "), /Install vendor prerequisite/);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(f.calls, ["install"]);
});
