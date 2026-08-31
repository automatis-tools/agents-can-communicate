import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { encode, publishAtomic, readJsonIfPresent } from "./atomic-json.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";

const STALE_MS = 60_000;
const ACQUIRE_TIMEOUT_MS = 2_500;
const OWNER = "owner.json";
const sleepFor = duration => new Promise(resolve => { setTimeout(resolve, duration); });

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

/**
 * Who holds the lock, or nothing if it moved while we looked.
 *
 * Reads inside the store refuse a parent directory whose identity changed
 * between the check and the open - the defence against a directory being
 * swapped under a read. This lock is the one directory whose entire life is
 * being created and removed: `mkdir` grants it, `rm` releases it, so its inode
 * changes every time it passes from one process to the next. Reading its owner
 * through the strict path meant a contended lock raised
 * "record parent directory changed while opening" and the whole command failed -
 * seen on Linux CI with four agents attaching to one fresh workspace, the
 * ordinary way two people start work.
 *
 * Here that is not an anomaly, it is the answer: the lock moved. Null says so,
 * and both callers already do the right thing with it - the acquiring loop waits
 * and looks again, and the releasing branch declines to remove a directory that
 * is no longer the one it created. The guard itself is untouched, and still
 * refuses everywhere a parent has no business changing.
 */
async function readOwner(directory, root, openFile) {
  try {
    const found = await readJsonIfPresent(path.join(directory, OWNER), root, openFile);
    return found?.value ?? null;
  } catch (error) {
    if (error instanceof AccError && error.code === EXIT.DATA
      && /parent directory changed/.test(error.message)) {
      return null;
    }
    throw error;
  }
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
    attempts = Number.POSITIVE_INFINITY, waitMs = 20, openFile,
    acquireTimeoutMs = ACQUIRE_TIMEOUT_MS, monotonicNow = () => performance.now(),
    sleep = sleepFor } = options;
  const directory = path.join(paths.locks, "writer.lock");
  // Wall time can jump while a process waits. A monotonic absolute deadline
  // bounds all owner reads and retries, leaving half the hook's five-second
  // budget for publishing the owner, doing the write, and rendering a result.
  const deadline = monotonicNow() + acquireTimeoutMs;
  await ensureManagedDirectory(root, paths.locks);
  const token = uuid();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (monotonicNow() >= deadline) break;
    try {
      await mkdir(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readOwner(directory, root, openFile);
      if (!await takeStaleOwnership(directory, root, owner, clock.now(), pidIsAlive)) {
        const remaining = deadline - monotonicNow();
        if (remaining <= 0) break;
        await sleep(Math.min(waitMs, remaining));
      }
      continue;
    }
    if (monotonicNow() >= deadline) {
      await rm(directory, { recursive: true, force: true });
      break;
    }
    const owner = { pid: process.pid, token, acquiredAt: clock.now() };
    await publishAtomic(path.join(directory, OWNER), encode(owner), { root, tmpDir: paths.tmp });
    try {
      return await operation();
    } finally {
      const current = await readOwner(directory, root, openFile);
      if (current?.token === token) await rm(directory, { recursive: true, force: true });
    }
  }
  throw new AccError(EXIT.CONFLICT, "another writer holds the store lock", { directory });
}
