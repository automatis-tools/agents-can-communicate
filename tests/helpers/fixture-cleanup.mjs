// Cleanup that removes a fixture directory after what ran inside it has stopped.
//
// node:test runs a test's after hooks in the order they were registered. A
// fixture registers its directory's removal before the test starts anything in
// that directory, so with plain `t.after` the directory goes first and a server
// the test started there is closed afterwards. POSIX allows that. Windows does
// not: a directory that is a live process's working directory, or that holds a
// file a process has open, cannot be removed (EBUSY), and the test fails in its
// cleanup although every assertion passed.
import { rm } from "node:fs/promises";

/**
 * A cleanup stack for `t`: each deferred function runs after the test, newest
 * first, the reverse of the order the resources were acquired. Every function
 * runs even when an earlier one fails; the first failure is reported.
 */
export function cleanupStack(t) {
  const stack = [];
  t.after(async () => {
    let failure = null;
    while (stack.length > 0) {
      try { await stack.pop()(); } catch (error) { failure ??= error; }
    }
    if (failure !== null) throw failure;
  });
  return fn => { stack.push(fn); };
}

/**
 * Removes a fixture directory. A process that has just exited can keep its hold
 * on Windows for a moment longer, and a detached worker ACC starts is designed
 * to outlive the command that started it, so there removal is retried. POSIX
 * removal is not retried: a failure there is a real race and must stay visible.
 */
export function removeFixture(directory) {
  return rm(directory, { recursive: true, force: true,
    ...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 100 } : {}) });
}
