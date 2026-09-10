import { createHash } from "node:crypto";
import { access, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { confirmedDead, defaultPidIsAlive } from "./mutex.mjs";
import { canonicalManagerRoot, managedDirectory, readManagedJson, syncDirectory, validateRuntime,
  writeManagedJson } from "./state.mjs";

const SCHEMA_VERSION = 1;

// Same hashing rule as session bindings: a foreign harness id never selects
// which file is written.
const fileFor = (root, harnessSessionId) => path.join(root, "pins",
  `${createHash("sha256").update(String(harnessSessionId)).digest("hex").slice(0, 32)}.json`);

// Where a generation's own hook lives, given its root. Computed once here and
// reused by every caller that needs it - a hook resolving a pin and the hook
// actually importing it - so the path checked and the path imported can never
// drift apart.
export const hookEntrypointFor = root => path.join(root, "bin", "entrypoints", "acc-hook.mjs");

// Every function below takes whatever `root` its caller happens to have -
// `entry.mjs` already canonicalises it before a hook ever sees it, but the
// hook-runner writes a pin from a raw data-home path it built itself. If only
// one side resolved symlinks, a symlinked data home would make the writer and
// the reader agree on the file's *name* but not its *location*: delegation
// would silently never fire, with no error anywhere. Canonicalising here,
// once, on every entry point - matching every other managed-runtime module -
// is what makes "the root the writer used" and "the root the reader used"
// the same derivation instead of two that merely happen to agree today.
export async function writePin({ root, harnessSessionId, runtimeRoot, version, storeVersion,
  clientPid }) {
  root = await canonicalManagerRoot(root);
  await managedDirectory(path.join(root, "pins"), { create: true });
  await writeManagedJson(fileFor(root, harnessSessionId), { schemaVersion: SCHEMA_VERSION,
    harnessSessionId, runtimeRoot, version, storeVersion: storeVersion ?? null,
    clientPid: clientPid ?? null, createdAt: new Date().toISOString() });
}

export async function readPin({ root, harnessSessionId }) {
  root = await canonicalManagerRoot(root);
  // Mirrors reapPins: an internal symlink swapped in for the pins directory
  // must not be followed into silently, whether writing or reading.
  if (!await managedDirectory(path.join(root, "pins"))) return null;
  const record = await readManagedJson(fileFor(root, harnessSessionId)).catch(() => null);
  if (!record || record.schemaVersion !== SCHEMA_VERSION
    || typeof record.runtimeRoot !== "string" || record.runtimeRoot === "") return null;
  return record;
}

export async function clearPin({ root, harnessSessionId }) {
  root = await canonicalManagerRoot(root);
  await rm(fileFor(root, harnessSessionId), { force: true });
}

/** Returns the pinned generation's root when a hook should delegate to it,
 * and null when it should stay on the active generation. Resolution never
 * throws: a hook that cannot resolve a pin must still let the client
 * proceed, so every reason to say no - no pin, an already-active pin, a
 * pinned generation outside the manager's own `generations` directory, one
 * missing its own hook entrypoint, a store that will not read - collapses to
 * the same null.
 *
 * Containment reuses `validateRuntime`, the same rule a control record's own
 * generation pointer is held to, rather than trusting a pin's `runtimeRoot`
 * on its word: a pin can be written by an unmanaged hook run sharing a data
 * home (a development checkout is its own nearest `accStoreVersion`
 * manifest), and importing whatever such a pin names would run this
 * process's code from outside the runtime it was admitted into. */
export async function resolvePinnedGeneration({ root, harnessSessionId, active }) {
  try {
    const canonicalRoot = await canonicalManagerRoot(root);
    const pin = await readPin({ root: canonicalRoot, harnessSessionId });
    if (pin === null) return null;
    const { root: resolved } = await validateRuntime(canonicalRoot,
      { version: pin.version, root: pin.runtimeRoot, storeVersion: pin.storeVersion });
    const canonicalActive = typeof active === "string" ? await canonicalManagerRoot(active) : active;
    if (resolved === canonicalActive) return null;
    await access(hookEntrypointFor(resolved));
    return resolved;
  } catch { return null; }
}

/** A client that exits without SessionEnd leaves its pin behind. Admission
 * already reaps dead leases; pins follow the same confirmed-death rule. */
export async function reapPins({ root, pidIsAlive = defaultPidIsAlive } = {}) {
  root = await canonicalManagerRoot(root);
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
