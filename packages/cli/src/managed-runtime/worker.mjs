import { activatePending } from "./activation.mjs";
import { downloadRelease, fetchRelease, newerVersion } from "./download.mjs";
import { withManagerLock } from "./mutex.mjs";
import { readControl, writeControl } from "./state.mjs";

import { checkDue, networkDisabled } from "./policy.mjs";
export { CHECK_INTERVAL_MS, networkDisabled } from "./policy.mjs";

/** One pass. The worker lock owns scheduling; admission is held only for state changes. */
export async function performUpdate(root, { force = false, check = false, env = process.env,
  discover = fetchRelease, download = downloadRelease, activate = activatePending,
  ignorePid = null } = {}) {
  const initial = await readControl(root);
  if (initial === null) throw new Error("ACC is not enrolled; run acc install first");
  const data = { running: initial.active.version, auto: initial.auto, pin: initial.pin,
    pending: initial.pending?.version ?? null, notice: initial.notice };
  if (!force && !check && !initial.auto) return { ...data, checked: false, reason: "auto_off" };
  // Recovery is local; the hard no-network override must not strand a partial refresh.
  if (initial.pending && !check && (force || !networkDisabled(env))) {
    return { ...data, ...await activate(root, { env, ignorePid }), checked: false };
  }
  if (networkDisabled(env)) return { ...data, checked: false, reason: "network_disabled" };
  if (!force && !check && !checkDue(initial)) return { ...data, checked: false, reason: "not_due" };
  if (!check) await withManagerLock(root, async () => {
    const current = await readControl(root);
    await writeControl(root, { ...current, checkedAt: new Date().toISOString() });
  });
  const release = await discover({ pin: initial.pin, env });
  const newer = newerVersion(release.version, initial.active.version);
  const checked = { ...data, checked: true, latest: release.version, newer };
  if (check || !newer) return checked;
  const generation = await download(root, release, { env });
  const published = await withManagerLock(root, async () => {
    const current = await readControl(root);
    if (current.phase !== "ready" || current.active.root !== initial.active.root
      || current.pin !== initial.pin || !force && !current.auto) return false;
    await writeControl(root, { ...current, pending: generation,
      notice: `ACC ${generation.version} is downloaded and verified.` });
    return true;
  });
  if (!published) return { ...checked, reason: "state_changed" };
  return { ...checked, pending: generation.version, ...await activate(root, { env, ignorePid }) };
}

/** A single detached worker may wait cheaply for native clients to exit. */
export async function runWorker(root, { force = false, env = process.env, wait = false, ignorePid = null } = {}) {
  return withManagerLock(`${root}/worker`, async () => {
    for (;;) {
      const result = await performUpdate(root, { force, env, ignorePid });
      if (!wait || result.reason !== "processes_active") return result;
      await new Promise(resolve => setTimeout(resolve, 60_000));
      if (!(await readControl(root))?.auto || networkDisabled(env)) return result;
    }
  }, { timeoutMs: 100 });
}

export async function recordWorkerFailure(root, error) {
  // A second scheduled worker losing the lock is ordinary, not a failed update.
  if (/manager lock held/.test(error?.message ?? "")) return;
  await withManagerLock(root, async () => {
    const control = await readControl(root);
    if (control) await writeControl(root, { ...control,
      notice: "Automatic update could not finish; the previous runtime was kept. Run acc update for details." });
  }).catch(() => {});
}
