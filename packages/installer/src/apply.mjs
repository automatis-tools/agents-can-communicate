import { applyNativeActivation, deactivateNative } from "./native-activation.mjs";
import { finalizeRemoval, missingArtifactParents, recordInstall,
  removeEmptyOwnedDirectories, removeOwnedArtifacts } from "./ownership.mjs";

/**
 * Carry out a plan, one adapter at a time.
 *
 * Each adapter is its own unit of work: it is installed, and only then is its
 * ownership recorded. A crash between two adapters therefore leaves the first
 * fully installed and recorded and the second untouched - and because every
 * adapter's install is idempotent, re-running finishes the job rather than
 * doubling the part that already succeeded.
 *
 * A failure does not end the run. Someone installing four clients wants the
 * three that work, plus the name of the one that did not.
 */
export async function applyPlan({ plan, adapters, context, dataHome, dryRun = false,
  accVersion = null, activation = {} }) {
  const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
  const results = { action: plan.action, dryRun, operations: [], skipped: plan.skipped,
    failed: [] };

  for (const operation of plan.operations) {
    const adapter = byId.get(operation.adapterId);
    if (dryRun) {
      // Nothing is opened, let alone written. The plan already says what would
      // happen, and re-deriving it here would be a second implementation of the
      // thing the operator is being shown.
      results.operations.push({ ...operation, changes: [], applied: false });
      continue;
    }

    try {
      if (plan.action === "install") {
        const createdDirectories = await missingArtifactParents({ home: context.home,
          artifacts: operation.artifacts });
        const installContext = { ...context,
          requestedLivePolicy: operation.livePolicy ?? "off",
          livePolicy: operation.effectiveLivePolicy ?? "off" };
        const outcome = await adapter.install(installContext);
        // A consented activation is applied after the adapter's own wiring, in
        // a fixed order; an explicit off takes a recorded one back first so the
        // record written below describes the machine as it now is.
        const notes = [];
        if (operation.deactivation !== undefined) {
          const report = await deactivateNative({ nativeActivation: operation.deactivation,
            ...activation });
          notes.push(...describeTeardown(report));
        }
        let native = null;
        let appendedRcBlock = false;
        if (operation.nativeActivation !== undefined) {
          const applied = await applyNativeActivation({ adapter,
            activation: operation.nativeActivation, dataHome, ...activation });
          native = applied.nativeActivation;
          appendedRcBlock = applied.appendedRcBlock;
        }
        // Recorded after the write, so a record never claims an install that
        // did not happen. The reverse order would leave uninstall trying to
        // remove files nothing created.
        await recordInstall({ dataHome, adapterId: adapter.id,
          version: operation.clientVersion ?? null, accVersion,
          artifacts: operation.artifacts, createdDirectories, nativeActivation: native });
        results.operations.push({ ...operation, applied: true, appendedRcBlock,
          changes: outcome.changes ?? [], diagnostics: [
            ...(operation.deliveryDiagnostic === undefined
              ? [] : [operation.deliveryDiagnostic]),
            ...(outcome.diagnostics ?? []),
            ...notes,
          ] });
      } else {
        // Keep the record until every cleanup step succeeds. It is both the
        // authority for deletion and the only durable recipe a retry has when
        // the client or one of ACC's own artifacts is already gone.
        const notes = [];
        if (operation.deactivation !== undefined) {
          const report = await deactivateNative({ nativeActivation: operation.deactivation,
            ...activation });
          notes.push(...describeTeardown(report));
        }
        const owned = await removeOwnedArtifacts({ dataHome, adapterId: adapter.id });
        // What ownership held back is passed on, because the adapter would
        // otherwise remove its own layout unconditionally and undo the decision.
        // The case that matters: someone put their own work inside a directory
        // ACC created, and a recognised path is not a reason to delete it.
        const outcome = await adapter.uninstall({ ...context, keep: owned.kept });
        const directories = await removeEmptyOwnedDirectories({ home: context.home,
          directories: owned.createdDirectories });
        await finalizeRemoval({ dataHome, adapterId: adapter.id });
        results.operations.push({ ...operation, applied: true,
          changes: outcome.changes ?? [], removed: owned.removed, kept: owned.kept,
          removedDirectories: directories.removed, keptDirectories: directories.kept,
          missingDirectories: directories.missing,
          diagnostics: [...(outcome.diagnostics ?? []), ...notes] });
      }
    } catch (error) {
      results.failed.push({ adapterId: operation.adapterId, error: error.message });
    }
  }
  return results;
}

// What a deactivation actually did, said truthfully: a retained service is
// named as retained, a modified PATH block as kept.
function describeTeardown(report) {
  const lines = [];
  if (report.shell !== null) {
    for (const file of report.shell.removedShims) lines.push(`removed shim ${file}`);
    for (const file of report.shell.keptShims) lines.push(`kept shim ${file} - changed since ACC wrote it`);
    if (report.shell.rcBlock === "removed") lines.push("removed the ACC PATH block");
    if (report.shell.rcBlock === "modified") lines.push("kept the ACC PATH block - changed since ACC wrote it");
    if (report.shell.rcBlock === "kept") lines.push("kept the ACC PATH block - another ACC shim still uses it");
  }
  for (const service of report.services) {
    lines.push(service.outcome === "stopped" ? `stopped the ${service.serviceId} service`
      : `retained the ${service.serviceId} service (${service.outcome === "retained_pre_existing"
        ? "it existed before ACC" : "no vendor teardown exists"})`);
  }
  return lines;
}
