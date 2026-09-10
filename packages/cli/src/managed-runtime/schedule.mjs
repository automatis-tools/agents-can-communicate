import { spawn } from "node:child_process";
import path from "node:path";
import { confirmedDead } from "./mutex.mjs";
import { readManagedJson } from "./state.mjs";
import { checkDue, networkDisabled } from "./policy.mjs";

/** No network waits here: this only starts an independent background process. */
export async function scheduleWorker(root, control, { env = process.env } = {}) {
  if (!control?.auto || networkDisabled(env) || !control.pending && !checkDue(control)) return false;
  try {
    for (const directory of [path.join(root, "worker"), path.join(root, "worker", "poller")]) {
      const owner = await readManagedJson(path.join(directory, "manager.lock", "owner.json"));
      if (Number.isSafeInteger(owner?.pid) && !await confirmedDead(owner.pid)) return false;
    }
    const child = spawn(process.execPath,
      [path.join(control.active.root, "bin", "acc-update-worker.mjs"), root], {
        env, detached: true, stdio: "ignore", cwd: root,
      });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}
