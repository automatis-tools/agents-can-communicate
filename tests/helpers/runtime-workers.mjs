// Waiting for what ACC left running in a fixture before the fixture goes.
//
// An entry point can start ACC's detached runtime worker (#208 reclaim, #263
// store upgrade, an update), which outlives the command by design and writes
// under the data home. `acc install` starts one in a fresh data home. A client's
// hooks do the same at its end: closing a real Claude Code's terminal runs its
// SessionEnd hook, which records the session's close in the data home while
// removal walks it, and removal failed with ENOTEMPTY (1 run in 5, 0.9.1 release
// check; the documented-commands test under a loaded suite, 2026-10-06).
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Resolves once no manager lock is held in `dataHome` and no process names one
 * of `roots` (or the /tmp alias of one) in its arguments, or after `timeoutMs`.
 * `strict` rejects inspection failures and the deadline instead of assuming quiet.
 * Windows has no `ps` here; strict inspection is unsupported there. Existing
 * fixture callers retain their best-effort wait and fixture-cleanup retry.
 */
export async function runtimeWorkersQuiet(dataHome, {
  roots = [dataHome], timeoutMs = 30_000, strict = false,
} = {}) {
  if (strict && process.platform === "win32") {
    throw new Error("Strict runtime worker inspection is unavailable on Windows");
  }
  const end = Date.now() + timeoutMs;
  const timedOut = () => new Error(`Timed out waiting for runtime workers in ${dataHome}`);
  // Bound filesystem inspection too; a stalled read never proves quiescence.
  const inspect = async operation => {
    if (!strict) return operation();
    const remaining = end - Date.now();
    if (remaining <= 0) throw timedOut();
    let timer;
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(timedOut()), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  const runtime = path.join(dataHome, "acc", "runtime");
  const locks = [path.join(runtime, "worker", "manager.lock"),
    path.join(runtime, "worker", "poller", "manager.lock")];
  const names = [...new Set(roots.flatMap(root => [root, root.replace(/^\/private\//, "/")]))];
  const running = async () => {
    if (process.platform === "win32") return false;
    try {
      // The deadline must terminate our own inspector even if it ignores TERM.
      const { stdout } = await inspect(() => run("ps", ["-Ao", "args="],
        strict ? { timeout: Math.max(1, end - Date.now()), killSignal: "SIGKILL" } : {}));
      return stdout.split("\n").some(line => names.some(name => line.includes(name)));
    } catch (error) {
      if (strict) throw new Error(`Cannot inspect runtime workers: ${error.message}`, { cause: error });
      return false;
    }
  };
  while (Date.now() < end) {
    const held = await inspect(() => Promise.all(locks.map(lock => lstat(lock).then(() => true, error => {
      if (strict && error.code !== "ENOENT") throw error;
      return false;
    }))));
    if (!held.some(Boolean) && !await running()) return;
    await new Promise(resolve => setTimeout(resolve, strict ? Math.min(200, Math.max(0, end - Date.now())) : 200));
  }
  if (strict) throw timedOut();
}
