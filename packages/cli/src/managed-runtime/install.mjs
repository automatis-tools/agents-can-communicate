import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateManagedLocation } from "./location.mjs";
import { stageOwnGeneration } from "./generation.mjs";
import { writeLaunchers } from "./launchers.mjs";
import { canonicalManagerRoot, readControl, writeControl } from "./state.mjs";
import { scheduleWorker } from "./schedule.mjs";
import { withManagerLock } from "./mutex.mjs";

const exec = promisify(execFile);
export async function verifyGeneration(runtime, { env = process.env } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "acc-runtime-check-"));
  try {
    const { stdout } = await exec(process.execPath,
      [path.join(runtime.root, "bin", "acc.mjs"), "version", "--json"], {
        env: { ...env, ACC_DATA_HOME: path.join(temporary, "data"), ACC_NO_UPDATE_CHECK: "1" },
        cwd: temporary, timeout: 10_000, maxBuffer: 64 * 1024,
      });
    if (JSON.parse(stdout)?.data?.version !== runtime.version) throw new Error("runtime version check failed");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Only the actual CLI composition supplies packageRoot; dry runs never enroll. */
export async function installManaged({ packageRoot, managerRoot, dataHome, home, targets, env, apply, cwd }) {
  const root = await validateManagedLocation({ managerRoot, dataHome, home, cwd, env });
  const candidate = await stageOwnGeneration({ packageRoot, managerRoot: root });
  await verifyGeneration(candidate, { env });
  return withManagerLock(root, async () => {
    const previous = await readControl(root);
    if (previous !== null && previous.home !== home) {
      throw new Error("this ACC data home manages another client home; use a separate ACC_DATA_HOME");
    }
    if (previous !== null && previous.active.root !== candidate.root) {
      throw new Error("install from the active managed runtime; use acc update to switch versions");
    }
    const runtime = { version: candidate.version, root: candidate.root };
    const control = { schemaVersion: 1, active: runtime, pending: runtime, phase: "activating",
      auto: previous?.auto ?? true, pin: previous?.pin ?? null,
      checkedAt: previous?.checkedAt ?? null, home,
      targets: [...new Set([...(previous?.targets ?? []), ...targets])], notice: null };
    await writeControl(root, control);
    const paths = await writeLaunchers(root, runtime.root);
    const result = await apply({ ...paths, preserveVersions: true });
    if (result.failed.length === 0) {
      const ready = await writeControl(root, { ...control, phase: "ready", pending: null });
      await scheduleWorker(root, ready, { env });
    } else {
      await writeControl(root, { ...control, notice: "Integration refresh is incomplete; run acc update to recover." });
    }
    return result;
  });
}

/** Removal updates enrollment under the same fence, so an updater cannot reinstall it. */
export async function uninstallManaged({ managerRoot, apply }) {
  const root = await canonicalManagerRoot(managerRoot);
  return withManagerLock(root, async () => {
    const control = await readControl(root);
    if (!control) return apply();
    if (control.phase !== "ready") throw new Error("finish the interrupted update with acc update before uninstalling");
    const result = await apply();
    const removed = new Set(result.operations.filter(operation => operation.applied)
      .map(operation => operation.adapterId));
    const targets = control.targets.filter(id => !removed.has(id));
    await writeControl(root, { ...control, targets,
      auto: targets.length > 0 && result.failed.length === 0 && control.auto,
      pending: targets.length > 0 ? control.pending : null, notice: null });
    return result;
  });
}
