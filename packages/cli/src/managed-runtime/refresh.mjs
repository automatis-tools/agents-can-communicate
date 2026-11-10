import path from "node:path";
import { applyPlan, detectInstallation, livePolicyOf, loadOwnership, planInstallation }
  from "@agents-can-communicate/installer";
import { ALL_ADAPTERS, clientContext, plannedLivePolicy, probeTimeout, recordedLivePolicies }
  from "../install-command.mjs";
import { processIsZombie } from "@agents-can-communicate/adapter-sdk";
import { defaultDelivery } from "../install-delivery-consent.mjs";
import { sweepStaleBindings } from "./activation.mjs";
import { listRuntimeHolds } from "./leases.mjs";
import { stablePaths, writeLaunchers } from "./launchers.mjs";
import { bridgeLegacyMaintenance } from "./legacy-maintenance.mjs";

/** Loaded from the candidate, so its own adapters supply its integration bytes. */
export async function prepareRefresh({ control, root, env = process.env, callerProtocol = 1 }) {
  await bridgeLegacyMaintenance({ control, root, env, callerProtocol });
  // An older generation lists its blockers right after this returns, by a rule
  // that counts a binding without a client pid as a live client forever (#273).
  await sweepStaleBindings(root).catch(() => {});
  // It counts a zombie's lease as a live ACC process too (#280); a zombie's lease
  // is removed like a dead process's.
  await listRuntimeHolds(root, { zombie: processIsZombie }).catch(() => {});
  const dataHome = path.dirname(path.dirname(root));
  const wanted = new Set(control.targets);
  const adapters = ALL_ADAPTERS().filter(adapter => wanted.has(adapter.id));
  if (adapters.length !== wanted.size) throw new Error("candidate cannot refresh every installed integration");
  // The version this refresh is moving off. Clients that cache a plugin under
  // its version record one path per plugin and read it once per session, so a
  // session open across the update keeps running from the outgoing copy until it
  // restarts. Naming it here keeps that copy; everything older than it goes.
  const recorded = (await loadOwnership({ dataHome })).installs;
  const build = livePolicies => ({ ...clientContext(control.home, path.join(dataHome, "acc"),
    { env, dataHome, livePolicies }), ...stablePaths(root), keepPreviousVersion: control.active.version });
  const before = recordedLivePolicies(recorded);
  let context = build(before);
  const detected = await detectInstallation({ adapters, context, probeTimeoutMs: probeTimeout(env) });
  // An update gives a client the same default an install does, so delivery that
  // ACC itself left off comes on here. A person's own off stays.
  const defaults = defaultDelivery({ detected, recorded });
  const deliveryByAdapter = Object.fromEntries(adapters.map(adapter => [adapter.id,
    defaults.deliveryByAdapter[adapter.id]
      ?? livePolicyOf(recorded.find(record => record.adapterId === adapter.id))]));
  const deliveryDecisionByAdapter = Object.fromEntries(adapters.flatMap(adapter => {
    const decision = defaults.deliveryDecisionByAdapter[adapter.id]
      ?? recorded.find(record => record.adapterId === adapter.id)?.deliveryDecision;
    return decision === undefined ? [] : [[adapter.id, decision]];
  }));
  // Refresh configuration even when the client's service is temporarily absent.
  // The installer preserves consent and existing activation; readiness stays a
  // separate, current probe result rather than an update prerequisite.
  const planWith = planned => planInstallation({ adapters, detected, context: planned, recorded,
    accVersion: control.pending.version, requested: control.targets, deliveryByAdapter,
    deliveryDecisionByAdapter });
  let plan = planWith(context);
  // A receiver can activate for the first time in this plan: a recorded opt-in
  // for a client the outgoing version could not deliver to live (Kimi Web before
  // 0.14.0). Its loopback listener exists only in this plan, so the senders are
  // planned again for the policies the refresh leaves behind.
  const after = { ...before, ...Object.fromEntries(plan.operations
    .map(operation => [operation.adapterId, plannedLivePolicy(operation)])) };
  const following = build(after);
  if (following.receiverLoopback !== context.receiverLoopback) {
    context = following;
    plan = planWith(context);
  }
  if (plan.skipped.length || plan.operations.length !== wanted.size) {
    throw new Error("candidate did not plan every installed integration");
  }
  return async () => {
    await writeLaunchers(root, control.pending.root);
    const result = await applyPlan({ plan, adapters, context, dataHome, accVersion: control.pending.version });
    return { ...result, failed: result.failed.map(failure => ({ ...failure,
      paths: plan.operations.find(operation => operation.adapterId === failure.adapterId)
        ?.artifacts?.map(artifact => artifact.path).filter(file => typeof file === "string") ?? [],
    })) };

  };
}
