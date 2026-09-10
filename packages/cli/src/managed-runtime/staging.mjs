import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { confirmedDead, defaultPidIsAlive } from "./mutex.mjs";
import { managedDirectory, readManagedJson, syncDirectory, writeManagedJson } from "./state.mjs";

const SCHEMA_VERSION = 1;

/** Staging renames a fully-formed generation into place, then runs it as a
 * spawned process to verify it, before any control pointer, lease, or pin
 * can reference it - out of the manager lock, since verification can run for
 * several seconds and holding the lock that long would stall every hook on
 * the machine. This hold closes that window: the caller writes it for the
 * generation's final path *before* the rename that makes the directory
 * visible there, so the directory can never be observed without it. */
export async function holdStagedGeneration({ root, generationRoot, pid = process.pid }) {
  const directory = path.join(root, "staging");
  await managedDirectory(directory, { create: true });
  await writeManagedJson(path.join(directory, `${randomUUID()}.json`),
    { schemaVersion: SCHEMA_VERSION, generationRoot, pid, createdAt: new Date().toISOString() });
}

/** A staging process that exits without publishing (crash, kill, a failed
 * verify) leaves its hold behind. Same confirmed-death rule as reapPins:
 * never explicitly cleared on the success path either, since a published
 * generation is independently protected by the control pointer and the
 * leftover hold is then just redundant bookkeeping this reaps in its turn. */
export async function reapStagingHolds({ root, pidIsAlive = defaultPidIsAlive } = {}) {
  const directory = path.join(root, "staging");
  if (!await managedDirectory(directory)) return;
  let removed = false;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    const record = await readManagedJson(file).catch(() => null);
    const pid = Number.isSafeInteger(record?.pid) ? record.pid : null;
    if (pid !== null && await confirmedDead(pid, pidIsAlive)) {
      await rm(file, { force: true });
      removed = true;
    }
  }
  if (removed) await syncDirectory(directory);
}
