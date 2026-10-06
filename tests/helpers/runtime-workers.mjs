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
 * Windows has no `ps` here; there removal itself is retried (fixture-cleanup).
 */
export async function runtimeWorkersQuiet(dataHome, { roots = [dataHome], timeoutMs = 30_000 } = {}) {
  const runtime = path.join(dataHome, "acc", "runtime");
  const locks = [path.join(runtime, "worker", "manager.lock"),
    path.join(runtime, "worker", "poller", "manager.lock")];
  const names = [...new Set(roots.flatMap(root => [root, root.replace(/^\/private\//, "/")]))];
  const running = async () => {
    if (process.platform === "win32") return false;
    const { stdout } = await run("ps", ["-Ao", "args="]).catch(() => ({ stdout: "" }));
    return stdout.split("\n").some(line => names.some(name => line.includes(name)));
  };
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const held = await Promise.all(locks.map(lock => lstat(lock).then(() => true, () => false)));
    if (!held.some(Boolean) && !await running()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
