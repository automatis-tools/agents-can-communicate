import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPlan } from "../src/apply.mjs";
import { loadOwnership } from "../src/ownership.mjs";
import { planInstallation } from "../src/plan.mjs";

test("delivery decision provenance survives plan, apply, and maintenance replanning", async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-decision-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-decision-data-")));
  t.after(() => Promise.all([home, dataHome]
    .map(directory => rm(directory, { recursive: true, force: true }))));
  const context = { home, dataHome };
  const adapter = {
    id: "decision_fixture",
    displayName: "Decision Fixture",
    capabilities: { delivery: { livePush: true } },
    planInstall: () => [],
    install: async () => ({ changes: [], diagnostics: [] }),
  };
  const detected = [{
    adapterId: adapter.id,
    displayName: adapter.displayName,
    present: true,
    version: "1.0.0",
    installed: false,
    capabilities: adapter.capabilities,
    nativeDelivery: {
      state: "eligible",
      reasonCode: null,
      eligibility: { eligible: true, protocolContract: "decision-v1" },
      activationPlan: { eligible: true, reasonCode: null, mechanisms: [] },
    },
  }];
  const decision = { source: "interactive-accepted", completeSetup: true };
  const firstPlan = planInstallation({
    adapters: [adapter],
    detected,
    context,
    deliveryByAdapter: { decision_fixture: "actionable" },
    deliveryDecisionByAdapter: { decision_fixture: decision },
    allowServiceSetup: true,
  });

  assert.deepEqual(firstPlan.operations[0].deliveryDecision, decision);
  await applyPlan({ plan: firstPlan, adapters: [adapter], context, dataHome });
  const recorded = (await loadOwnership({ dataHome })).installs;
  assert.deepEqual(recorded[0].deliveryDecision, decision);

  const refreshPlan = planInstallation({
    adapters: [adapter],
    detected,
    context,
    recorded,
    deliveryByAdapter: { decision_fixture: "actionable" },
  });
  assert.deepEqual(refreshPlan.operations[0].deliveryDecision, decision);
  await applyPlan({ plan: refreshPlan, adapters: [adapter], context, dataHome });
  assert.deepEqual((await loadOwnership({ dataHome })).installs[0].deliveryDecision, decision);
});
