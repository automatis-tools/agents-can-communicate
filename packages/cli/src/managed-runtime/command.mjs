import { AccError, EXIT } from "@agents-can-communicate/protocol";
import { stableVersion, newerVersion } from "./download.mjs";
import { withManagerLock } from "./mutex.mjs";
import { scheduleWorker } from "./schedule.mjs";
import { readControl, writeControl } from "./state.mjs";
import { performUpdate, runWorker } from "./worker.mjs";
import { requestMaintenance } from "./maintenance.mjs";
import { retireLegacyUpdateWorker, stageNewerManagementRuntime } from "./management-recovery.mjs";

export function validateUpdateOptions(options) {
  if (options.yes && (options.check || options.auto !== undefined || options.pin !== undefined)) {
    throw new AccError(EXIT.USAGE, "--yes only consents to client maintenance during acc update");
  }
  if (options.auto !== undefined && !["on", "off"].includes(options.auto)) {
    throw new AccError(EXIT.USAGE, "--auto expects on or off");
  }
  if (options.pin !== undefined && options.pin !== "none" && !stableVersion(options.pin)) {
    throw new AccError(EXIT.USAGE, "--pin expects an exact stable version or none");
  }
  if (options.check && (options.auto !== undefined || options.pin !== undefined)) {
    throw new AccError(EXIT.USAGE, "--check cannot change update settings");
  }
}

export async function runManagedUpdate({ options, runtime }) {
  const root = runtime.managerRoot;
  const env = runtime.env ?? {};
  try {
    if (options.auto !== undefined || options.pin !== undefined) {
      const control = await withManagerLock(root, async () => {
        const current = await readControl(root);
        if (!current) throw new Error("run acc install before configuring automatic updates");
        if (current.phase !== "ready" && options.pin !== undefined) throw new Error("finish the interrupted update before changing its version pin");
        const pin = options.pin === undefined ? current.pin : options.pin === "none" ? null : options.pin;
        if (pin !== null && newerVersion(current.active.version, pin)) {
          throw new Error("pin cannot downgrade workspace data; choose the running version or a newer release");
        }
        return writeControl(root, { ...current,
          auto: options.auto === undefined ? current.auto : options.auto === "on", pin,
          autoPreference: options.auto === undefined ? current.autoPreference ?? current.auto : options.auto === "on",
          pending: options.pin !== undefined && current.pending?.version !== pin ? null : current.pending,
          notice: null });
      });
      await scheduleWorker(root, control, { env });
      return { data: { auto: control.auto, pin: control.pin, running: control.active.version },
        text: `Automatic updates ${control.auto ? "on" : "off"}. ${control.pin ? `Pinned to ${control.pin}.` : "Following stable releases."}` };
    }
    if (!options.check) await stageNewerManagementRuntime(root, runtime);
    const result = options.check
      ? await performUpdate(root, { check: true, env })
      : await runWorker(root, { force: true, env, ignorePid: process.pid });
    if (!options.check && (result.reason === "processes_active" || result.reason === "maintenance_pending"
      || result.activated || result.checked && !result.newer)) {
      const maintenance = await requestMaintenance({ root, control: await readControl(root), options, runtime });
      if (maintenance) return maintenance;
    }
    const text = result.activated ? `Updated ACC to ${result.version}; integrations refreshed.`
      : result.notice && result.reason === "processes_active" ? result.notice
        : result.reason === "refresh_failed" ? [result.notice,
          ...(result.installation?.failed ?? []).map(failure =>
            `${failure.adapterId}: ${failure.error}${failure.paths?.length ? ` (${failure.paths.join(", ")})` : ""}`),
          ...(!result.installation?.failed?.length && result.error ? [result.error] : [])].join("\n")
          : result.checked ? result.newer ? `ACC ${result.latest} is available; run acc update.`
            : `ACC ${result.running} is current${result.pin ? ` for pin ${result.pin}` : ""}.`
            : result.reason === "network_disabled" ? "Update networking is off (ACC_NO_UPDATE_CHECK)."
              : result.notice ?? "Update is pending.";
    return { data: result, text,
      ...(result.reason === "refresh_failed" ? { error: new AccError(EXIT.DATA, text) } : {}) };
  } catch (error) {
    if (/manager lock held/.test(error.message)) {
      if (!options.check && options.auto === undefined && options.pin === undefined && !runtime.legacyWorkerRetried
        && await retireLegacyUpdateWorker(root).catch(() => false)) {
        return runManagedUpdate({ options, runtime: { ...runtime, legacyWorkerRetried: true } });
      }
      return { data: { inProgress: true }, text: "An update is already in progress; ACC will activate it when running clients exit." };
    }
    throw error instanceof AccError ? error : new AccError(EXIT.DATA, error.message);
  }
}
