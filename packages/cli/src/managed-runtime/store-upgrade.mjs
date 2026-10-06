import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { assertPortableId, createId } from "@agents-can-communicate/protocol";
import { migrateFilesystemStore, STORE_VERSION } from "@agents-can-communicate/storage-filesystem";

import { listActivationBlockers } from "./activation.mjs";
import { withManagerLock } from "./mutex.mjs";
import { readControl, writeManagedJson } from "./state.mjs";

/**
 * Move this data home's older stores to the contract this generation speaks.
 *
 * #263 made contract 6 to 7 an explicit `acc doctor --migrate-store` in each
 * workspace. With automatic updates on, a user who ran nothing found every
 * workspace without coordination after the update, its remedy on a stderr line
 * Claude Code does not show (2026-10-06). The activation of a contract-7
 * runtime already waits until no live process holds contract 6, so right after
 * it - and on every later worker pass - the same check guards each store's
 * migration, under the same admission mutex as the explicit command. The mutex
 * is taken per store, so an entry waits at most one store's migration.
 */
export const STORE_UPGRADE_MARKER = "store-upgrade.json";

const workspacesOf = root => path.join(path.dirname(root), "workspaces");
const systemClock = { now: () => new Date().toISOString() };
const systemIds = { next: kind => createId(kind, randomBytes) };

/** The stores in this data home whose contract is older than this code's. */
export async function olderStores(root) {
  const workspaces = workspacesOf(root);
  const names = await readdir(workspaces).catch(() => []);
  const found = [];
  for (const name of names) {
    const dir = path.join(workspaces, name);
    try {
      assertPortableId(name);
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const identity = JSON.parse(await readFile(path.join(dir, "protocol.json"), "utf8"));
      if (identity?.workspaceId === name && Number.isSafeInteger(identity.storeVersion)
        && identity.storeVersion < STORE_VERSION) {
        found.push({ workspaceId: name, dir, storeVersion: identity.storeVersion });
      }
    } catch { /* Not a store, or not one this pass can read; the explicit command reports it. */ }
  }
  return found;
}

/**
 * Migrate every older store that no live older client holds. Records the pass
 * in STORE_UPGRADE_MARKER and returns one outcome per store.
 */
export async function migrateOlderStores(root, { ignorePid = process.pid, clock = systemClock,
  ids = systemIds, platform = process.platform, migrate = migrateFilesystemStore } = {}) {
  const control = await readControl(root);
  if (!control?.active) return [];
  const outcomes = [];
  // Recorded even when this generation migrates nothing, so the launcher's
  // scheduler, which knows no contract, stops asking for a pass.
  const stores = control.active.storeVersion === STORE_VERSION ? await olderStores(root) : [];
  for (const store of stores) {
    let state;
    try {
      state = await withManagerLock(root, async () => {
        const current = await readControl(root);
        if (current?.phase !== "ready" || current.active?.storeVersion !== STORE_VERSION) return "not_ready";
        const blockers = await listActivationBlockers(root, { incomingStoreVersion: STORE_VERSION,
          ignorePid, strictNative: true });
        if (blockers.length > 0) return "blocked";
        await migrate({ root: store.dir, workspaceId: store.workspaceId, clock, ids, platform,
          allowMigration: true });
        return "migrated";
      });
    } catch {
      state = "failed";
    }
    outcomes.push({ workspaceId: store.workspaceId, state });
  }
  await writeManagedJson(path.join(root, STORE_UPGRADE_MARKER), { schemaVersion: 1,
    activeRoot: control.active.root, complete: outcomes.every(item => item.state === "migrated"),
    pending: outcomes.filter(item => item.state !== "migrated").length,
    attemptedAt: new Date().toISOString() });
  return outcomes;
}
