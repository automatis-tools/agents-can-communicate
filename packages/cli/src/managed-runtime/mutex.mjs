import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalManagerRoot, managedDirectory, readManagedJson, syncDirectory, writeManagedJson } from "./state.mjs";

export function defaultPidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export async function confirmedDead(pid, pidIsAlive = defaultPidIsAlive) {
  try { return await pidIsAlive(pid) === false; }
  catch (error) { return error.code === "ESRCH"; }
}

const identity = owner => createHash("sha256")
  .update(JSON.stringify([owner.pid, owner.token, owner.acquiredAt])).digest("hex");

async function lockDirectoryIdentity(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("manager lock is not a regular directory");
    return info;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOwner(directory) {
  const before = await lockDirectoryIdentity(directory);
  if (!before) return null;
  const owner = await readManagedJson(path.join(directory, "owner.json"));
  const after = await lockDirectoryIdentity(directory);
  // Publication and retirement replace the entire directory. Missing owner
  // bytes only prove corruption when both observations refer to the same lock.
  if (!after || before.dev !== after.dev || before.ino !== after.ino) return null;
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.token !== "string" || !owner.token
    || typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))) {
    throw new Error("invalid manager lock owner; refusing to reclaim");
  }
  return owner;
}

async function retire(directory, target) {
  try { await rename(directory, target); return true; }
  catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
}

/** Process death is the only expiry. Retained tombstones fence stale observers. */
export async function withManagerLock(root, operation, { timeoutMs = 1000, pidIsAlive = defaultPidIsAlive } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("invalid manager lock timeout");
  root = await canonicalManagerRoot(root);
  await managedDirectory(root, { create: true });
  const directory = path.join(root, "manager.lock");
  const owner = { pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString() };
  const candidate = path.join(root, `manager.candidate-${owner.token}.lock`);
  const deadline = performance.now() + timeoutMs;
  await mkdir(candidate, { mode: 0o700 });
  let owned = false;
  try {
    await writeManagedJson(path.join(candidate, "owner.json"), owner);
    await syncDirectory(candidate);
    while (performance.now() < deadline) {
      const current = await readOwner(directory);
      if (current) {
        if (await confirmedDead(current.pid, pidIsAlive)) {
          // Never delete this nonempty target. Every observer of the same dead
          // owner uses it; a late observer cannot rename a successor over it.
          const tombstone = path.join(root, `manager.reclaimed-${identity(current)}.lock`);
          if (await retire(directory, tombstone)) await syncDirectory(root);
        }
      } else {
        try {
          await rename(candidate, directory);
          owned = true;
          await syncDirectory(root);
          return await operation();
        } catch (error) {
          if (owned || !["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        }
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)));
    }
    throw new Error("manager lock held; acquisition timeout");
  } finally {
    if (owned) {
      const current = await readOwner(directory);
      if (current?.token === owner.token) {
        // A release tombstone also fences observers that inspected this owner
        // before release and resume after a successor has been published.
        const released = path.join(root, `manager.reclaimed-${identity(owner)}.lock`);
        if (await retire(directory, released)) await syncDirectory(root);
      }
    } else await rm(candidate, { recursive: true, force: true });
  }
}
