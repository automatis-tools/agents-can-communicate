import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { encode, readJsonIfPresent } from "./atomic-json.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";
import { withRegularNoFollow } from "./safe-file.mjs";

const STALE_MS = 60_000;
const ACQUIRE_TIMEOUT_MS = 2_500;
const OWNER = "owner.json";
const sleepFor = duration => new Promise(resolve => { setTimeout(resolve, duration); });

// A fully prepared directory is the atomic primitive. Publishing the owner
// with the directory means a crash can leave an unused candidate, but never an
// ownerless canonical lock that blocks every later writer.
function defaultPidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareCandidate(paths, root, owner) {
  const identity = createHash("sha256").update(owner.token).digest("hex");
  const candidate = path.join(paths.locks, `writer.candidate-${identity}.lock`);
  await mkdir(candidate);
  try {
    await withRegularNoFollow(path.join(candidate, OWNER), root,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, async handle => {
        await handle.writeFile(encode(owner));
        await handle.sync();
      });
    await syncDirectory(candidate);
    return candidate;
  } catch (error) {
    await rm(candidate, { recursive: true, force: true });
    throw error;
  }
}

async function releaseCanonical(directory, root, owner, openFile) {
  const current = await readOwner(directory, root, openFile);
  if (current?.token !== owner.token) return;
  // Recursive removal would first unlink owner.json and briefly expose an
  // empty canonical directory. Move the complete lock aside atomically so a
  // successor can only arrive after this owner has left the canonical name.
  const identity = createHash("sha256")
    .update(JSON.stringify([owner.pid, owner.token, owner.acquiredAt]))
    .digest("hex");
  const retired = path.join(path.dirname(directory), `writer.released-${identity}.lock`);
  try {
    await rename(directory, retired);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return;
    throw error;
  }
  await rm(retired, { recursive: true, force: true });
}

/**
 * Who holds the lock, or nothing if it moved while we looked.
 *
 * Reads inside the store refuse a parent directory whose identity changed
 * between the check and the open - the defence against a directory being
 * swapped under a read. This lock is the one directory whose entire life is
 * being published and retired: `rename` grants and releases it, so its inode
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
  // Every contender that observed this owner names the same retained target.
  // rename() moves the whole lock atomically; exactly one contender can put it
  // there. The target is deliberately left non-empty. A late contender cannot
  // rename a successor over it, so a stale pathname observation never becomes
  // permission to remove the writer that acquired the lock afterwards.
  const identity = createHash("sha256")
    .update(JSON.stringify([owner.pid, owner.token, owner.acquiredAt]))
    .digest("hex");
  const reclaimed = path.join(path.dirname(directory), `writer.reclaimed-${identity}.lock`);
  try {
    await rename(directory, reclaimed);
    return true;
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
}

export async function withWriterMutex(paths, options, operation) {
  const { root, clock, pidIsAlive = defaultPidIsAlive, uuid = randomUUID,
    attempts = Number.POSITIVE_INFINITY, waitMs = 20, openFile,
    acquireTimeoutMs = ACQUIRE_TIMEOUT_MS, monotonicNow = () => performance.now(),
    wallNow = Date.now, deadlineAt, sleep = sleepFor } = options;
  const directory = path.join(paths.locks, "writer.lock");
  // Wall time can jump while a process waits. A monotonic absolute deadline
  // bounds all owner reads and retries, leaving half the hook's five-second
  // budget for publishing the owner, doing the write, and rendering a result.
  const started = monotonicNow();
  const callerBudget = deadlineAt === undefined
    ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt - wallNow());
  const deadline = started + Math.min(acquireTimeoutMs, callerBudget);
  await ensureManagedDirectory(root, paths.locks);
  const token = uuid();
  const owner = { pid: process.pid, token, acquiredAt: clock.now() };
  const candidate = await prepareCandidate(paths, root, owner);
  let ownsCanonical = false;

  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (monotonicNow() >= deadline) break;
      try {
        // POSIX rename replaces an empty directory atomically. That recovers a
        // lock left by the old mkdir-then-publish sequence. A live publisher
        // either fills it first (so rename fails) or loses its no-replace owner
        // publication after this complete candidate wins.
        await rename(candidate, directory);
        ownsCanonical = true;
        await syncDirectory(paths.locks);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        const current = await readOwner(directory, root, openFile);
        if (!await takeStaleOwnership(directory, root, current, clock.now(), pidIsAlive)) {
          const remaining = deadline - monotonicNow();
          if (remaining <= 0) break;
          await sleep(Math.min(waitMs, remaining));
        }
        continue;
      }
      if (monotonicNow() >= deadline) break;
      return await operation();
    }
  } finally {
    if (ownsCanonical) {
      await releaseCanonical(directory, root, owner, openFile);
    } else {
      const current = await readOwner(candidate, root, openFile);
      if (current?.token === token) {
        await rm(candidate, { recursive: true, force: true });
      }
    }
  }
  const reason = deadlineAt !== undefined && wallNow() >= deadlineAt
    ? "transaction deadline expired while waiting for the store lock"
    : "another writer holds the store lock";
  throw new AccError(EXIT.CONFLICT, reason, { directory });
}
