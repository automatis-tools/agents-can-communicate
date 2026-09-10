import { ALL_ADAPTERS } from "../install-command.mjs";
import { activatePending, listActivationBlockers } from "./activation.mjs";
import { confirmedDead, defaultPidIsAlive, withManagerLock } from "./mutex.mjs";
import { readControl } from "./state.mjs";
import { maintenanceContext } from "./maintenance.mjs";
import { MAINTENANCE_ACTIVE, maintenanceRecipe, readMaintenance, writeMaintenance } from "./maintenance-state.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = waiting => Object.assign(new Error("maintenance waiting"), { code: "MAINTENANCE_WAIT", waiting });
const refused = reasonCode => Object.assign(new Error("maintenance refused"), { reasonCode });

/** No runtime lease: this worker must outlive the client that requested it.
 * Its own mutex serializes checkpoints; admission remains separately fenced.
 */
export async function runMaintenance(root, { jobId, env = process.env, adapters = ALL_ADAPTERS(),
  pidIsAlive = defaultPidIsAlive, pause = sleep, now = Date.now, activate = activatePending } = {}) {
  return withManagerLock(`${root}/maintenance-worker`, async () => {
    let job;
    // Publication owns admission until spawn's PID is durable. Wait for it
    // before writing checkpoints, including when recovering an older job.
    await withManagerLock(root, async () => {
      job = await readMaintenance(root);
      if (job && (!jobId || job.id === jobId) && MAINTENANCE_ACTIVE.includes(job.status)) {
        job = await writeMaintenance(root, { ...job, workerPid: process.pid });
      }
    });
    if (!job || jobId && job.id !== jobId || !MAINTENANCE_ACTIVE.includes(job.status)) return job;
    const save = async changes => { job = await writeMaintenance(root, { ...job, ...changes }); return job; };
    const waitFor = async waiting => {
      if (JSON.stringify(job.waiting) !== JSON.stringify(waiting)) await save({ waiting });
      await pause(1000);
    };
    const adapter = adapters.find(a => a.id === job.services[0].adapterId);
    if (!adapter?.stopForMaintenance || !adapter.startAfterMaintenance) return save({ status: "failed", reasonCode: "maintenance_adapter_unavailable" });
    const expected = job.services[0].snapshot;
    let control = await readControl(root);
    const context = maintenanceContext(control, env);

    async function restore(result, reasonCode = null) {
      await save({ status: "restarting", reasonCode });
      let restarted;
      try { restarted = await adapter.startAfterMaintenance({ context, expected }); }
      catch { restarted = { ok: false, reasonCode: "service_start_failed" }; }
      if (!restarted?.ok) return save({ status: "recovery", reasonCode: restarted?.reasonCode ?? "service_start_failed" });
      return save({ status: result?.activated ? "completed" : "failed",
        reasonCode: result?.activated ? null : reasonCode ?? result?.reason ?? "update_incomplete" });
    }

    // A crash after the stop checkpoint can mean either side of the command.
    // Never repeat it. Forward repair still obeys native/ACC lifetime fences,
    // then the idempotent adapter start restores the already-approved service.
    if (job.attempted.length) {
      let result;
      try {
        control = await readControl(root);
        if (!control.pending && control.active.root === job.target.root && control.phase === "ready") result = { activated: true };
        else if (maintenanceRecipe(control) === job.recipe) {
          result = await withManagerLock(`${root}/worker`, () => activate(root, { env, pidIsAlive }));
        }
      } catch { /* Restoration still runs when forward repair is unavailable. */ }
      return restore(result, result?.reason ?? "maintenance_interrupted");
    }

    for (;;) {
      control = await readControl(root);
      if (maintenanceRecipe(control) !== job.recipe) return save({ status: "cancelled", reasonCode: "update_state_changed" });
      if (now() > job.deadline) return save({ status: "cancelled", reasonCode: "idle_wait_expired" });
      if (!await confirmedDead(job.callerPid, pidIsAlive)) { await waitFor({ reason: "caller_exit" }); continue; }
      let result;
      try {
        result = await withManagerLock(`${root}/worker`, async () => {
          const beforeActivation = async current => {
            if (maintenanceRecipe(current) !== job.recipe) throw refused("update_state_changed");
            const blockers = await listActivationBlockers(root, { pidIsAlive });
            const others = blockers.filter(b => b.pid !== expected.pid || b.kinds.some(kind => kind !== "native"));
            if (others.length) throw deferred({ reason: "other_processes", processes: others.length });
            const snapshot = await adapter.inspectMaintenance(context);
            if (snapshot?.state === "busy") throw deferred({ reason: "service_busy",
              busyThreads: snapshot.busyThreads, queuedRequests: snapshot.queuedRequests });
            if (snapshot?.state !== "ready") throw refused("service_readiness_changed");
            // Durable before the vendor command: recovery restores without
            // assuming whether the previous worker reached the actual stop.
            await save({ status: "stopping", attempted: [adapter.id], waiting: null });
            const stopped = await adapter.stopForMaintenance({ context, expected });
            if (stopped?.ok === false && stopped.stopAttempted === false) {
              await save({ status: "waiting", attempted: [] });
              if (stopped.reasonCode === "service_busy") throw deferred({ reason: "service_busy",
                busyThreads: stopped.snapshot?.busyThreads, queuedRequests: stopped.snapshot?.queuedRequests });
            }
            if (!stopped?.ok) throw refused(stopped?.reasonCode ?? "service_stop_failed");
            await save({ status: "refreshing" });
          };
          if (control.pending) return activate(root, { env, pidIsAlive, beforeActivation });
          return withManagerLock(root, async () => {
            await beforeActivation(await readControl(root));
            return { activated: true, version: control.active.version };
          });
        }, { timeoutMs: 100 });
      } catch (error) {
        if (!job.attempted.length && (error.code === "MAINTENANCE_WAIT" || /manager lock held/.test(error.message))) {
          await waitFor(error.waiting ?? { reason: "update_worker" }); continue;
        }
        if (job.attempted.length) return restore(null, error.reasonCode ?? "maintenance_failed");
        return save({ status: "failed", reasonCode: error.reasonCode ?? "maintenance_failed" });
      }
      if (job.attempted.length) return restore(result);
      return save({ status: "cancelled", reasonCode: result?.reason ?? "update_state_changed" });
    }
  }, { timeoutMs: 100, pidIsAlive });
}
