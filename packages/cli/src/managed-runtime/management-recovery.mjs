import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { declaredStoreVersion } from "./activation.mjs";
import { newerVersion } from "./download.mjs";
import { stageOwnGeneration } from "./generation.mjs";
import { verifyGeneration } from "./install.mjs";
import { confirmedDead, withManagerLock } from "./mutex.mjs";
import { readControl, readManagedJson, writeControl } from "./state.mjs";
import { releaseStagingHold } from "./staging.mjs";

/** A newly installed global CLI can supersede an older pending release locally.
 * No workspace code or integration is admitted until normal activation passes.
 */
export async function stageNewerManagementRuntime(root, { packageRoot, env }) {
  if (!packageRoot) return false;
  const before = await readControl(root);
  const manifest = await readManagedJson(path.join(packageRoot, "package.json"));
  if (before?.phase !== "ready" || manifest?.name !== "agents-can-communicate"
    || manifest.accManagedUpdateProtocol !== 2 || before.pin && before.pin !== manifest.version
    || !newerVersion(manifest.version, before.pending?.version ?? before.active.version)) return false;
  const candidate = await stageOwnGeneration({ packageRoot, managerRoot: root });
  // See installManaged for why this releases only after the publish attempt
  // - success or not - has fully resolved.
  try {
    await verifyGeneration(candidate, { env });
    return await withManagerLock(root, async () => {
      const current = await readControl(root);
      if (current.phase !== "ready" || current.pin !== before.pin
        || JSON.stringify([current.active, current.pending]) !== JSON.stringify([before.active, before.pending])) return false;
      await writeControl(root, { ...current, pending: { root: candidate.root,
        version: candidate.version, storeVersion: await declaredStoreVersion(candidate.root) },
        notice: `ACC ${candidate.version} is verified and ready to activate.` });
      return true;
    });
  } finally {
    await releaseStagingHold(candidate.hold);
  }
}

async function inspectWorker(pid) {
  try {
    const { stdout } = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,command="],
      { timeout: 2000, maxBuffer: 16384 });
    const match = /^\s*(\d+)\s+(.{24})\s+(.+)\s*$/.exec(stdout);
    return match ? { uid: Number(match[1]), start: match[2], command: match[3] } : null;
  } catch { return null; }
}

/** 0.4.2/0.4.3 kept this ACC-owned worker lock while sleeping indefinitely.
 * Retire only an exactly identified old helper, under the admission mutex in
 * ready phase. Never interrupt integration writes, a client, or an unknown PID.
 */
export async function retireLegacyUpdateWorker(root, { inspect = inspectWorker,
  signal = pid => process.kill(pid, "SIGTERM"), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  return withManagerLock(root, async () => {
    const control = await readControl(root);
    if (control?.phase !== "ready") return false;
    const manifest = await readManagedJson(path.join(control.active.root, "package.json"));
    if (manifest?.accManagedUpdateProtocol === 2) return false;
    const ownerFile = path.join(root, "worker", "manager.lock", "owner.json");
    const owner = await readManagedJson(ownerFile);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 2 || owner.pid === process.pid
      || typeof owner.token !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))) return false;
    const observed = await inspect(owner.pid);
    const suffix = ` ${path.join(control.active.root, "bin", "acc-update-worker.mjs")} ${root}`;
    const executable = observed?.command.endsWith(suffix) ? observed.command.slice(0, -suffix.length) : null;
    const elapsed = Date.parse(owner.acquiredAt) - Date.parse(observed?.start);
    if (!executable || !path.isAbsolute(executable) || path.basename(executable) !== "node"
      || observed.uid !== process.getuid?.() || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 60_000) return false;
    if (JSON.stringify(await readManagedJson(ownerFile)) !== JSON.stringify(owner)
      || JSON.stringify(await inspect(owner.pid)) !== JSON.stringify(observed)) return false;
    signal(owner.pid);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await confirmedDead(owner.pid)) return true;
      await pause(50);
    }
    return false; // Normal mutex reclamation still requires confirmed death.
  });
}
