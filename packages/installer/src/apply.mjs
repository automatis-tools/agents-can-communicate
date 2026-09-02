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
  accVersion = null }) {
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
        // Recorded after the write, so a record never claims an install that
        // did not happen. The reverse order would leave uninstall trying to
        // remove files nothing created.
        await recordInstall({ dataHome, adapterId: adapter.id,
          version: operation.clientVersion ?? null, accVersion,
          artifacts: operation.artifacts, createdDirectories });
        results.operations.push({ ...operation, applied: true,
          changes: outcome.changes ?? [], diagnostics: [
            ...(operation.deliveryDiagnostic === undefined
              ? [] : [operation.deliveryDiagnostic]),
            ...(outcome.diagnostics ?? []),
          ] });
      } else {
        // Keep the record until every cleanup step succeeds. It is both the
        // authority for deletion and the only durable recipe a retry has when
        // the client or one of ACC's own artifacts is already gone.
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
          diagnostics: outcome.diagnostics ?? [] });
      }
    } catch (error) {
      results.failed.push({ adapterId: operation.adapterId, error: error.message });
    }
  }
  return results;
}
