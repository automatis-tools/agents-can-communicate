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
 *
 * `pid` must be a real, positive process id - the argument this function
 * answers a question about. It is not where "nobody knows" is answered:
 * `defaultPidIsAlive(null)` returns `false`, the same as a confirmed-dead pid,
 * because a non-positive integer fails the `Number.isInteger` guard below the
 * same way a made-up one would. The design this function serves requires the
 * opposite reading for a session with no recorded pid - "cannot tell", never
 * "dead" - so every call site in this repository guards on `pid !== null`
 * before calling it. This is exported as the canonical liveness probe, so a
 * caller reached from outside that guard must add its own, or a pid-less
 * session will read as dead here regardless of how the rest of the system
 * treats it.
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
