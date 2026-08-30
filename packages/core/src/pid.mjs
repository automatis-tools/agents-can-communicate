/**
 * Whether a process with this id exists.
 *
 * Signal 0 runs the existence and permission checks without delivering
 * anything. `ESRCH` is the only answer that means gone: `EPERM` says the
 * process is there and owned by somebody else, which is still there.
 *
 * Deliberately not shared with the writer lock's copy in the storage package.
 * `core` may not import storage (tests/package-boundaries.test.mjs), and the two
 * ask the question about different subjects - a lock owner mid-write, and a
 * session that may have ended hours ago.
 */
export function defaultPidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
