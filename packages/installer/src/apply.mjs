import { recordInstall, removeOwned } from "./ownership.mjs";

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
export async function applyPlan({ plan, adapters, context, dataHome, dryRun = false }) {
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
        const outcome = await adapter.install(context);
        // Recorded after the write, so a record never claims an install that
        // did not happen. The reverse order would leave uninstall trying to
        // remove files nothing created.
        await recordInstall({ dataHome, adapterId: adapter.id,
          version: operation.clientVersion ?? null, artifacts: operation.artifacts });
        results.operations.push({ ...operation, applied: true,
          changes: outcome.changes ?? [], diagnostics: outcome.diagnostics ?? [] });
      } else {
        // Ownership first: it decides what may be deleted, and the adapter's own
        // uninstall then unpicks the entries it added to files the user owns.
        const owned = await removeOwned({ dataHome, adapterId: adapter.id });
        // What ownership held back is passed on, because the adapter would
        // otherwise remove its own layout unconditionally and undo the decision.
        // The case that matters: someone put their own work inside a directory
        // ACC created, and a recognised path is not a reason to delete it.
        const outcome = await adapter.uninstall({ ...context, keep: owned.kept });
        results.operations.push({ ...operation, applied: true,
          changes: outcome.changes ?? [], removed: owned.removed, kept: owned.kept,
          diagnostics: outcome.diagnostics ?? [] });
      }
    } catch (error) {
      results.failed.push({ adapterId: operation.adapterId, error: error.message });
    }
  }
  return results;
}
