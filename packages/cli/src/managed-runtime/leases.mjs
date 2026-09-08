import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalManagerRoot, managedDirectory, readControl, readManagedJson,
  syncDirectory, validateRuntime, writeManagedJson } from "./state.mjs";
import { confirmedDead, defaultPidIsAlive, withManagerLock } from "./mutex.mjs";

/** Admission and lease publication must finish inside the pointer's mutex. */
export async function acquireRuntime(root, { pid = process.pid, kind = "cli" } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof kind !== "string" || !kind) {
    throw new Error("invalid runtime lease identity");
  }
  root = await canonicalManagerRoot(root);
  return withManagerLock(root, async () => {
    const control = await readControl(root);
    if (!control) throw new Error("managed runtime is not initialized");
    if (control.phase !== "ready") throw new Error("managed runtime activation in progress");
    const lease = { schemaVersion: 1, token: randomUUID(), pid, kind,
      runtime: control.active, createdAt: new Date().toISOString() };
    const directory = path.join(root, "leases");
    await managedDirectory(directory, { create: true });
    await writeManagedJson(path.join(directory, `${lease.token}.json`), lease);
    return lease;
  });
}

/** Management decisions call this under withManagerLock to exclude admissions.
 * Records are immutable and uniquely named; confirmed-dead cleanup also works
 * outside a transaction. No release-on-return or timestamp expiry exists.
 */
export async function listRuntimeHolds(root, { pidIsAlive = defaultPidIsAlive } = {}) {
  root = await canonicalManagerRoot(root);
  if (!await managedDirectory(root)) return [];
  const directory = path.join(root, "leases");
  if (!await managedDirectory(directory)) return [];
  const holds = [];
  let removed = false;
  for (const name of (await readdir(directory)).sort()) {
    if (name.startsWith(".record-") && name.endsWith(".tmp")) continue;
    if (!name.endsWith(".json")) throw new Error("invalid runtime lease file");
    const file = path.join(directory, name);
    const lease = await readManagedJson(file);
    if (lease === undefined) continue;
    if (!lease || lease.schemaVersion !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid <= 0
      || typeof lease.token !== "string" || name !== `${lease.token}.json`
      || typeof lease.kind !== "string" || !lease.kind
      || !Number.isFinite(Date.parse(lease.createdAt))) throw new Error("invalid runtime lease");
    await validateRuntime(root, lease.runtime);
    if (await confirmedDead(lease.pid, pidIsAlive)) {
      await rm(file, { force: true });
      removed = true;
    } else holds.push(lease);
  }
  if (removed) await syncDirectory(directory);
  return holds;
}
