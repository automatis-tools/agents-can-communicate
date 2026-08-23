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

/**
 * Reclaim a lock nobody is holding.
 *
 * A hook is a process a client is free to kill, and clients do: they all put a
 * timeout on it. Killed mid-write, it leaves this directory behind with its own
 * pid in it. Requiring the lock to be *both* dead and a minute old meant that
 * for the next sixty seconds no write in the workspace could proceed - no
 * intent, no claim, no message, and no session could attach. Hooks fail open,
 * so none of it was visible: the session simply never appeared, and `acc
 * status` went on reporting the ones that had.
 *
 * A dead owner is reclaimed at once. There is nothing to wait for: the lock
 * holds no state beyond its own owner file, and the process that would have
 * finished the write is gone.
 *
 * The age still matters for the one case liveness cannot answer. A pid is
 * recycled, so a dead owner's number can come back attached to something
 * unrelated, and then `pidIsAlive` says yes forever. Sixty seconds is far longer
 * than any write here takes - the hook budget is five - so a holder that old is
 * not a writer that is still going.
 */
async function takeStaleOwnership(directory, root, owner, now, pidIsAlive) {
  if (owner === null) return false;
  const age = Date.parse(now) - Date.parse(owner.acquiredAt);
  if (pidIsAlive(owner.pid) && !(age > STALE_MS)) return false;
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
