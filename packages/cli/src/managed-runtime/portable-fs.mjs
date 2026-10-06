// Filesystem calls whose meaning differs on Windows, each measured on a
// windows-latest runner (docs/design/2026-09-30-native-windows-support.md).
// POSIX keeps the single call it always made; the Windows branch keeps the rule
// the caller relies on. Node built-ins only: the managed runtime's launchers
// carry a byte-identical copy of this file, and they may import nothing else.
import { constants } from "node:fs";
import * as fs from "node:fs/promises";

const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
// Long enough for a reader, an antivirus scan or an indexer to let go; short
// enough that a hook's budget is spent on the write, not on waiting.
const DEFAULT_WAIT_MS = 2_000;
const BACKOFF_MS = [5, 10, 20, 40, 80];
const STEADY_MS = 100;

const sleepFor = duration => new Promise(resolve => { setTimeout(resolve, duration); });

export const isWindows = (platform = process.platform) => platform === "win32";

async function retrying(operation, retry, { deadlineAt, sleep = sleepFor }) {
  const deadline = deadlineAt ?? Date.now() + DEFAULT_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !await retry(error)) throw error;
      await sleep(Math.min(BACKOFF_MS[attempt] ?? STEADY_MS, remaining));
    }
  }
}

/**
 * Rename a file over an existing one.
 *
 * Windows refuses the rename while any handle is open on the target - an ACC
 * reader, an antivirus scan, an indexer - whatever sharing that handle allows.
 * The handle is always short-lived, so the rename is retried until the caller's
 * deadline rather than failing a write whose bytes are ready.
 */
export async function renameReplacing(from, to, { platform = process.platform,
  rename = fs.rename, deadlineAt, sleep } = {}) {
  if (!isWindows(platform)) return rename(from, to);
  return retrying(() => rename(from, to), error => BUSY.has(error.code), { deadlineAt, sleep });
}

/**
 * Rename a directory, or move any entry to a name nobody else uses.
 *
 * POSIX reports an occupied name as EEXIST or ENOTEMPTY, and callers treat that
 * as "somebody else got there first". Windows reports it as EPERM, the same code
 * it uses when a file inside the source is open. The target tells them apart:
 * if it exists the answer is EEXIST, as on POSIX; if not, the source was busy
 * and the rename is retried.
 */
export async function renameEntry(from, to, { platform = process.platform,
  rename = fs.rename, lstat = fs.lstat, deadlineAt, sleep } = {}) {
  if (!isWindows(platform)) return rename(from, to);
  return retrying(async () => {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!BUSY.has(error.code)) throw error;
      const occupied = await lstat(to).then(() => true, missing => {
        if (missing.code === "ENOENT") return false;
        throw missing;
      });
      if (occupied) {
        throw Object.assign(new Error(`EEXIST: file already exists, rename '${from}' -> '${to}'`),
          { code: "EEXIST", syscall: "rename", path: from, dest: to });
      }
      throw error;
    }
  }, error => BUSY.has(error.code), { deadlineAt, sleep });
}

// A name inside a directory another process is deleting - a waiting writer's
// rmdir of a lock its owner emptied - answers lstat with EPERM until the
// deletion is done (measured on windows-latest: lstat of writer.lock\owner.json
// while eight writers elected one, 2026-10-06, and the waiting writer failed
// instead of looking again). The name is asked again within the caller's
// deadline: what it settles to is the answer, and an EPERM that outlasts the
// deadline is kept.
async function lstatSettled(file, lstat, { deadlineAt, sleep }) {
  try {
    return await retrying(() => lstat(file, { bigint: true }), error => error.code === "EPERM",
      { deadlineAt, sleep });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const gone = (file, lstat, options) => lstatSettled(file, lstat, options)
  .then(stat => stat === null, () => false);

const refusedLink = file => Object.assign(
  new Error(`ELOOP: too many symbolic links encountered, open '${file}'`),
  { code: "ELOOP", syscall: "open", path: file });

// How many times a name that keeps changing hands is opened afresh.
const SWAPS = 3;

/**
 * Open a file without following a symlink at its final component.
 *
 * Windows has no O_NOFOLLOW: the flag is undefined there and an open through a
 * file symlink succeeds. The rule is kept by checking the name first, refusing a
 * symlink or junction (Node reports both as symbolic links), and after the open
 * checking the name again: it must be no link, and name the very file the handle
 * holds. A name another process replaced in between - a lock changing hands, a
 * record renamed over - then names what was opened, as POSIX's O_NOFOLLOW open
 * would have taken it; a name that moved on again is opened afresh, a few times.
 */
export async function openNoFollow(file, flags, { mode, platform = process.platform,
  open = fs.open, lstat = fs.lstat, deadlineAt, sleep } = {}) {
  if (!isWindows(platform)) return open(file, flags | constants.O_NOFOLLOW, mode);
  for (let attempt = 1; ; attempt += 1) {
    const before = await lstatSettled(file, lstat, { deadlineAt, sleep });
    if (before?.isSymbolicLink()) throw refusedLink(file);
    // A scanner that opened the file without read sharing refuses every reader
    // with EBUSY until it lets go.
    const handle = await retrying(() => open(file, flags, mode), error => error.code === "EBUSY",
      { deadlineAt, sleep }).catch(async error => {
      // A name another process is deleting, or a lock changing hands around
      // it, refuses the open with EPERM, and the name is gone right after
      // (measured on windows-latest, for a name present before the open and
      // for one absent before it): that is ENOENT, as Linux says it. A name
      // that is still there keeps its EPERM, and so does a create on a name
      // that was free, which is a refused create.
      const refusedCreate = before === null && (flags & constants.O_CREAT) !== 0;
      if (error.code !== "EPERM" || refusedCreate
        || !await gone(file, lstat, { deadlineAt, sleep })) throw error;
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`,
        { cause: error }), { code: "ENOENT", syscall: "open", path: file });
    });
    try {
      const opened = await handle.stat({ bigint: true });
      const named = await lstatSettled(file, lstat, { deadlineAt, sleep });
      if (named?.isSymbolicLink()) throw refusedLink(file);
      if (named !== null && named.dev === opened.dev && named.ino === opened.ino) return handle;
      if (attempt >= SWAPS) throw refusedLink(file);
    } catch (error) {
      await handle.close();
      throw error;
    }
    await handle.close();
  }
}

/**
 * Make a rename or link that produced `entry` inside `directory` durable.
 *
 * POSIX syncs the directory. Windows refuses a flush on a directory handle, and
 * NTFS journals the rename as metadata: flushing the renamed file commits that
 * journal up to the file's last change, which includes the rename. A directory
 * entry (a lock taken by renaming a directory) guards live processes only and is
 * not flushed.
 */
export async function syncEntry(directory, entry, { platform = process.platform,
  open = fs.open, lstat = fs.lstat, deadlineAt, sleep } = {}) {
  if (!isWindows(platform)) {
    const handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { await handle.sync(); } finally { await handle.close(); }
    return;
  }
  if ((await lstat(entry)).isDirectory()) return;
  const handle = await retrying(() => open(entry, "r+"), error => error.code === "EBUSY",
    { deadlineAt, sleep });
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Remove a tree; Windows retries a file another process still holds. */
export async function removeTree(target, { platform = process.platform, rm = fs.rm } = {}) {
  await rm(target, { recursive: true, force: true,
    maxRetries: isWindows(platform) ? 10 : 0, retryDelay: 50 });
}
