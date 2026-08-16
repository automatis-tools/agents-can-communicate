import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { encode, publishAtomic, readJsonIfPresent } from "./atomic-json.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";

const STALE_MS = 60_000;
const OWNER = "owner.json";

// Directory creation is the atomic primitive: mkdir either creates or fails
// with EEXIST, with no window in between. Ported from the reconciled
// prototype's repair mutex and reused here as the per-workspace writer lock.
function defaultPidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function readOwner(directory, root) {
  const found = await readJsonIfPresent(path.join(directory, OWNER), root);
  return found?.value ?? null;
}

async function takeStaleOwnership(directory, root, owner, now, pidIsAlive) {
  if (owner === null) return false;
  const age = Date.parse(now) - Date.parse(owner.acquiredAt);
  if (!(age > STALE_MS) || pidIsAlive(owner.pid)) return false;
  // The owner is both old and gone. Removing the whole directory is safe
  // because the lock holds no state beyond its own owner file.
  await rm(directory, { recursive: true, force: true });
  return true;
}

export async function withWriterMutex(paths, options, operation) {
  const { root, clock, pidIsAlive = defaultPidIsAlive, uuid = randomUUID,
    attempts = 50, waitMs = 20 } = options;
  const directory = path.join(paths.locks, "writer.lock");
  await ensureManagedDirectory(root, paths.locks);
  const token = uuid();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await mkdir(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readOwner(directory, root);
      if (!await takeStaleOwnership(directory, root, owner, clock.now(), pidIsAlive)) {
        await new Promise(resolve => { setTimeout(resolve, waitMs); });
      }
      continue;
    }
    const owner = { pid: process.pid, token, acquiredAt: clock.now() };
    await publishAtomic(path.join(directory, OWNER), encode(owner), { root, tmpDir: paths.tmp });
    try {
      return await operation();
    } finally {
      const current = await readOwner(directory, root);
      if (current?.token === token) await rm(directory, { recursive: true, force: true });
    }
  }
  throw new AccError(EXIT.CONFLICT, "another writer holds the store lock", { directory });
}
