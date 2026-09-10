import { createHash } from "node:crypto";
import { access, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { confirmedDead, defaultPidIsAlive } from "./mutex.mjs";
import { managedDirectory, readManagedJson, syncDirectory, writeManagedJson } from "./state.mjs";

const SCHEMA_VERSION = 1;

// Same hashing rule as session bindings: a foreign harness id never selects
// which file is written.
const fileFor = (root, harnessSessionId) => path.join(root, "pins",
  `${createHash("sha256").update(String(harnessSessionId)).digest("hex").slice(0, 32)}.json`);

export async function writePin({ root, harnessSessionId, runtimeRoot, version, storeVersion,
  clientPid }) {
  await managedDirectory(path.join(root, "pins"), { create: true });
  await writeManagedJson(fileFor(root, harnessSessionId), { schemaVersion: SCHEMA_VERSION,
    harnessSessionId, runtimeRoot, version, storeVersion: storeVersion ?? null,
    clientPid: clientPid ?? null, createdAt: new Date().toISOString() });
}

export async function readPin({ root, harnessSessionId }) {
  const record = await readManagedJson(fileFor(root, harnessSessionId)).catch(() => null);
  if (!record || record.schemaVersion !== SCHEMA_VERSION
    || typeof record.runtimeRoot !== "string" || record.runtimeRoot === "") return null;
  return record;
}

export async function clearPin({ root, harnessSessionId }) {
  await rm(fileFor(root, harnessSessionId), { force: true });
}

/** Returns the pinned generation root when a hook should delegate to it, and
 * null when it should stay on the active generation. Resolution never throws:
 * a hook that cannot resolve a pin must still let the client proceed, so
 * every reason to say no - no pin, an already-active pin, a pinned generation
 * missing its own hook entrypoint, a store that will not read - collapses to
 * the same null. */
export async function resolvePinnedEntrypoint({ root, harnessSessionId, active }) {
  try {
    const pin = await readPin({ root, harnessSessionId });
    if (pin === null || pin.runtimeRoot === active) return null;
    await access(path.join(pin.runtimeRoot, "bin", "entrypoints", "acc-hook.mjs"));
    return pin.runtimeRoot;
  } catch { return null; }
}

/** A client that exits without SessionEnd leaves its pin behind. Admission
 * already reaps dead leases; pins follow the same confirmed-death rule. */
export async function reapPins({ root, pidIsAlive = defaultPidIsAlive } = {}) {
  const directory = path.join(root, "pins");
  if (!await managedDirectory(directory)) return;
  let removed = false;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    const record = await readManagedJson(file).catch(() => null);
    const pid = Number.isSafeInteger(record?.clientPid) ? record.clientPid : null;
    if (pid !== null && await confirmedDead(pid, pidIsAlive)) {
      await rm(file, { force: true });
      removed = true;
    }
  }
  if (removed) await syncDirectory(directory);
}
