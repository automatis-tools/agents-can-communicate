import path from "node:path";
import { applyPlan, detectInstallation, livePolicyOf, loadOwnership, planInstallation, shellOf }
  from "@agents-can-communicate/installer";
import { ALL_ADAPTERS, clientContext, probeTimeout } from "../install-command.mjs";
import { stablePaths, writeLaunchers } from "./launchers.mjs";

/** Loaded from the candidate, so its own adapters supply its integration bytes. */
export async function prepareRefresh({ control, root, env = process.env }) {
  const dataHome = path.dirname(path.dirname(root));
  const wanted = new Set(control.targets);
  const adapters = ALL_ADAPTERS().filter(adapter => wanted.has(adapter.id));
  if (adapters.length !== wanted.size) throw new Error("candidate cannot refresh every installed integration");
  const context = { ...clientContext(control.home, path.join(dataHome, "acc"),
    { env, shell: shellOf(env) }), ...stablePaths(root), preserveVersions: true };
  const recorded = (await loadOwnership({ dataHome })).installs;
  const detected = await detectInstallation({ adapters, context, probeTimeoutMs: probeTimeout(env) });
  const deliveryByAdapter = Object.fromEntries(adapters.map(adapter => [adapter.id,
    livePolicyOf(recorded.find(record => record.adapterId === adapter.id))]));
  // An unavailable probe cannot silently revoke an existing native opt-in.
  for (const detection of detected) {
    if (deliveryByAdapter[detection.adapterId] !== "off" && detection.nativeDelivery?.state !== "eligible") {
      throw new Error("native integration could not be verified; update remains pending");
    }
  }
  const plan = planInstallation({ adapters, detected, context, recorded,
    accVersion: control.pending.version, requested: control.targets, deliveryByAdapter });
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
