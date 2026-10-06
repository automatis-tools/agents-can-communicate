import { spawn } from "node:child_process";
import path from "node:path";
import { confirmedDead } from "./mutex.mjs";
import { readManagedJson } from "./state.mjs";
import { checkDue, networkDisabled } from "./policy.mjs";

// The active generation has not yet reclaimed with its own rule (#208): the
// worker records `reclaim.json` naming the root it reclaimed as. Local work, so
// neither the update opt-out nor the no-network override holds it back. An
// unreadable marker is not a reason to start a worker on every entry.
// A pass an unknown holder postponed is retried, at most hourly, so a holder
// that never becomes readable cannot start a worker on every entry.
const RECLAIM_RETRY_MS = 60 * 60_000;
async function reclaimDue(root, control) {
  let marker;
  try { marker = await readManagedJson(path.join(root, "reclaim.json")); } catch { return false; }
  if (marker?.activeRoot !== control.active.root) return true;
  if (marker.complete !== false) return false;
  const attempted = Date.parse(marker.attemptedAt);
  return !Number.isFinite(attempted) || Date.now() - attempted >= RECLAIM_RETRY_MS;
}

// The active generation has not yet moved this data home's older stores to its
// contract (#263; `store-upgrade.json`, which its worker writes on every pass),
// or a pass left a store behind a minute or more ago. Until it succeeds that
// workspace has no coordination, so the retry is soon. This module is copied
// into every launcher and imports only launcher modules; an import of the
// migration itself failed every hook with ERR_MODULE_NOT_FOUND (2026-10-06).
export const STORE_UPGRADE_RETRY_MS = 60_000;
export async function storeUpgradeDue(root, control, { now = Date.now() } = {}) {
  let marker;
  try { marker = await readManagedJson(path.join(root, "store-upgrade.json")); } catch { return false; }
  if (marker?.activeRoot !== control.active.root) return true;
  if (marker.complete !== false) return false;
  const attempted = Date.parse(marker.attemptedAt);
  return !Number.isFinite(attempted) || now - attempted >= STORE_UPGRADE_RETRY_MS;
}

/** No network waits here: this only starts an independent background process. */
export async function scheduleWorker(root, control, { env = process.env } = {}) {
  if (!control?.active) return false;
  const update = control.auto && !networkDisabled(env) && (control.pending || checkDue(control));
  if (!update && !await reclaimDue(root, control) && !await storeUpgradeDue(root, control)) return false;
  try {
    for (const directory of [path.join(root, "worker"), path.join(root, "worker", "poller")]) {
      const owner = await readManagedJson(path.join(directory, "manager.lock", "owner.json"));
      if (Number.isSafeInteger(owner?.pid) && !await confirmedDead(owner.pid)) return false;
    }
    const child = spawn(process.execPath,
      [path.join(control.active.root, "bin", "acc-update-worker.mjs"), root], {
        env, detached: true, windowsHide: true, stdio: "ignore", cwd: root,
      });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}
