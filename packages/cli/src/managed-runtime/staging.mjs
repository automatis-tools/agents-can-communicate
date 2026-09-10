import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { confirmedDead, defaultPidIsAlive } from "./mutex.mjs";
import { canonicalManagerRoot, managedDirectory, readManagedJson, syncDirectory, writeManagedJson } from "./state.mjs";

const SCHEMA_VERSION = 1;

/** Staging renames a fully-formed generation into place, then runs it as a
 * spawned process to verify it, before any control pointer, lease, or pin
 * can reference it - out of the manager lock, since verification can run for
 * several seconds and holding the lock that long would stall every hook on
 * the machine. This hold closes that window: the caller writes it for the
 * generation's final path *before* either the check that may return that
 * path unchanged, or the rename that makes a freshly staged one visible
 * there - so the directory can never be observed without it.
 *
 * Returns the hold's own file path: an opaque handle for attachStagingTemp
 * and releaseStagingHold. The caller owns its lifecycle end to end - this
 * function never releases what it creates. */
export async function holdStagedGeneration({ root, generationRoot, stagingRoot = null, pid = process.pid }) {
  const directory = path.join(root, "staging");
  await managedDirectory(directory, { create: true });
  const file = path.join(directory, `${randomUUID()}.json`);
  await writeManagedJson(file, { schemaVersion: SCHEMA_VERSION, generationRoot, stagingRoot, pid,
    createdAt: new Date().toISOString() });
  return file;
}

/** Once mkdtemp names the actual in-flight temp, attach it to the same
 * record a live hold already protects: a dead owner's abandoned temp is
 * only ever found by way of this link, since reclaim never otherwise looks
 * at a dot-prefixed generations entry. */
export async function attachStagingTemp(file, stagingRoot) {
  const record = await readManagedJson(file);
  await writeManagedJson(file, { ...record, stagingRoot });
}

/** The caller must call this on every exit from its own staging attempt -
 * success, a failed verify, a timeout, or a thrown error - once the
 * generation is either published (and so independently protected by the
 * control pointer) or abandoned. Confirmed-dead reaping is the backstop for
 * a crash that skips this, never the release mechanism itself. */
export async function releaseStagingHold(file) {
  if (typeof file === "string" && file) await rm(file, { force: true });
}

const nonempty = value => typeof value === "string" && value.length > 0;

/** A staging process that exits without releasing its hold (crash, kill, a
 * SIGKILL mid-verify) leaves both the hold and, if it had gotten that far,
 * its in-flight temp behind - the only sweeper either one ever gets. Same
 * confirmed-death rule as reapPins. The temp is only ever removed alongside
 * its owning record, and only after it is confirmed to sit directly inside
 * this root's own `generations`, named the way mkdtemp names one: a corrupt
 * or foreign path in the record must never turn a reap into an arbitrary
 * delete. */
export async function reapStagingHolds({ root, pidIsAlive = defaultPidIsAlive } = {}) {
  root = await canonicalManagerRoot(root);
  const directory = path.join(root, "staging");
  if (!await managedDirectory(directory)) return;
  const generations = path.join(root, "generations");
  let removed = false;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    const record = await readManagedJson(file).catch(() => null);
    const pid = Number.isSafeInteger(record?.pid) ? record.pid : null;
    if (pid !== null && await confirmedDead(pid, pidIsAlive)) {
      if (nonempty(record.stagingRoot)) {
        // Resolved the same way every generations entry is (see
        // resolveCandidate in activation.mjs): a symlinked data home must
        // never make a real temp look foreign, or a foreign path look real.
        const resolved = await canonicalManagerRoot(record.stagingRoot).catch(() => null);
        if (resolved && path.dirname(resolved) === generations && path.basename(resolved).startsWith(".staging-")) {
          await rm(resolved, { recursive: true, force: true });
        }
      }
      await rm(file, { force: true });
      removed = true;
    }
  }
  if (removed) await syncDirectory(directory);
}
