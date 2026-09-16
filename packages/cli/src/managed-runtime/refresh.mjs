import path from "node:path";
import { applyPlan, detectInstallation, livePolicyOf, loadOwnership, planInstallation, shellOf }
  from "@agents-can-communicate/installer";
import { ALL_ADAPTERS, clientContext, probeTimeout } from "../install-command.mjs";
import { stablePaths, writeLaunchers } from "./launchers.mjs";
import { bridgeLegacyMaintenance } from "./legacy-maintenance.mjs";

/** Loaded from the candidate, so its own adapters supply its integration bytes. */
export async function prepareRefresh({ control, root, env = process.env, callerProtocol = 1 }) {
  await bridgeLegacyMaintenance({ control, root, env, callerProtocol });
  const dataHome = path.dirname(path.dirname(root));
  const wanted = new Set(control.targets);
  const adapters = ALL_ADAPTERS().filter(adapter => wanted.has(adapter.id));
  if (adapters.length !== wanted.size) throw new Error("candidate cannot refresh every installed integration");
  // The version this refresh is moving off. Clients that cache a plugin under
  // its version record one path per plugin and read it once per session, so a
  // session open across the update keeps running from the outgoing copy until it
  // restarts. Naming it here keeps that copy; everything older than it goes.
  const context = { ...clientContext(control.home, path.join(dataHome, "acc"),
    { env, shell: shellOf(env), dataHome }), ...stablePaths(root),
  keepPreviousVersion: control.active.version };
  const recorded = (await loadOwnership({ dataHome })).installs;
  const detected = await detectInstallation({ adapters, context, probeTimeoutMs: probeTimeout(env) });
  const deliveryByAdapter = Object.fromEntries(adapters.map(adapter => [adapter.id,
    livePolicyOf(recorded.find(record => record.adapterId === adapter.id))]));
  const deliveryDecisionByAdapter = Object.fromEntries(adapters.flatMap(adapter => {
    const decision = recorded.find(record => record.adapterId === adapter.id)?.deliveryDecision;
    return decision === undefined ? [] : [[adapter.id, decision]];
  }));
  // Refresh configuration even when the client's service is temporarily absent.
  // The installer preserves consent and existing activation; readiness stays a
  // separate, current probe result rather than an update prerequisite.
  const plan = planInstallation({ adapters, detected, context, recorded,
    accVersion: control.pending.version, requested: control.targets, deliveryByAdapter,
    deliveryDecisionByAdapter });
  if (plan.skipped.length || plan.operations.length !== wanted.size) {
    throw new Error("candidate did not plan every installed integration");
  }
  return async () => {
    await writeLaunchers(root, control.pending.root);
    const result = await applyPlan({ plan, adapters, context, dataHome, accVersion: control.pending.version,
      activation: { bootstrap: context.bootstrap } });
    return { ...result, failed: result.failed.map(failure => ({ ...failure,
      paths: plan.operations.find(operation => operation.adapterId === failure.adapterId)
        ?.artifacts?.map(artifact => artifact.path).filter(file => typeof file === "string") ?? [],
    })) };

  };
}
