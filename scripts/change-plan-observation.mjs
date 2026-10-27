// Optional observations must never choose, suppress, or fail the existing gates.
import { createGatePlan } from "./change-plan.mjs";

export async function observePushPlans(repo, targets) {
  const started = performance.now();
  const observations = [];
  for (const target of targets) {
    const refs = [];
    for (const ref of target.refs) {
      const context = { ref: ref.remoteRef, targetCommit: ref.localOid, baseCommit: ref.remoteOid,
        policy: ref.remoteRef.startsWith("refs/heads/measure/") ? "measurement-only" : "normal" };
      try {
        const plan = await createGatePlan({ repo, targetCommit: ref.localOid, baseCommit: ref.remoteOid,
          event: { kind: "push", ref: ref.remoteRef } });
        refs.push({ ...context, plan });
      } catch { refs.push({ ...context, scope: "full", reason: "plan-unavailable" }); }
    }
    observations.push({ commit: target.commit, tree: target.tree, executionScope: target.requiredScope,
      scope: refs.length && refs.every(ref => ref.plan?.scope === "docs") ? "docs" : "full", refs });
  }
  return { schema: 1, observationOnly: true, durationMs: performance.now() - started, targets: observations };
}
