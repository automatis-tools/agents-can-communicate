import path from "node:path";
import { managedDirectory, readManagedJson, validateRuntime, writeManagedJson } from "./state.mjs";

export const MAINTENANCE_ACTIVE = ["waiting", "stopping", "refreshing", "restarting", "recovery"];
const statuses = [...MAINTENANCE_ACTIVE, "completed", "failed", "cancelled"];
export const maintenanceRecipe = c => JSON.stringify([c.active, c.pending, c.home, c.targets, c.auto, c.pin]);

export async function readMaintenance(root) {
  if (!await managedDirectory(root)) return null;
  const value = await readManagedJson(path.join(root, "maintenance.json"));
  if (value === undefined) return null;
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)
    || !statuses.includes(value.status) || typeof value.recipe !== "string"
    || typeof value.workerRoot !== "string" || !path.isAbsolute(value.workerRoot)
    || !Number.isFinite(value.deadline) || !Number.isSafeInteger(value.callerPid) || value.callerPid < 1
    || !(value.workerPid === null || Number.isSafeInteger(value.workerPid) && value.workerPid > 0)
    || !Array.isArray(value.services) || value.services.length !== 1
    || !value.services.every(s => typeof s.adapterId === "string" && s.snapshot
      && Number.isSafeInteger(s.snapshot.pid) && s.snapshot.pid > 0)
    || !Array.isArray(value.attempted) || !value.attempted.every(id => value.services.some(s => s.adapterId === id))) {
    throw new Error("invalid update maintenance record");
  }
  await validateRuntime(root, value.target);
  return value;
}

/** Caller holds the admission mutex or the exclusive maintenance-worker lock. */
export async function writeMaintenance(root, job) {
  await writeManagedJson(path.join(root, "maintenance.json"), job);
  return job;
}

export function maintenanceReport(job) {
  return { id: job.id, status: job.status, version: job.target.version,
    reasonCode: job.reasonCode ?? null, workerPid: job.workerPid,
    ...(job.status === "waiting" && job.waiting ? { waiting: job.waiting } : {}),
    services: job.services.map(({ adapterId, snapshot }) => ({ adapterId,
      serviceId: snapshot.serviceId, pid: snapshot.pid, clientVersion: snapshot.cliVersion,
      serverVersion: snapshot.serverVersion })) };
}

export function maintenanceNotice(job) {
  const version = job.target.version;
  if (job.status === "completed") return `ACC ${version} update maintenance completed; the client service was restarted and verified.`;
  if (job.status === "cancelled") return `Update maintenance cancelled (${job.reasonCode}); no client service was stopped.`;
  if (job.status === "failed") return `Update maintenance failed (${job.reasonCode}); run acc update to retry.`;
  if (job.status === "recovery") return `Client service recovery is pending (${job.reasonCode}); run acc update to retry recovery.`;
  if (job.status === "waiting") {
    const waiting = job.waiting?.reason === "service_busy" ? `idle client work (${job.waiting.busyThreads ?? "unknown"} active turns, ${job.waiting.queuedRequests ?? "unknown"} queued requests)`
      : job.waiting?.reason === "other_processes" ? `${job.waiting.processes} other or unidentified process(es) to exit`
        : job.waiting?.reason === "caller_exit" ? "the requesting command to exit"
          : job.waiting?.reason === "update_worker" ? "another ACC updater"
            : "idle clients and other ACC processes to exit";
    return `ACC ${version} update maintenance is scheduled; waiting for ${waiting}. Open clients will disconnect during restart. Check acc doctor for progress.`;
  }
  return `ACC ${version} update maintenance: ${job.status}. Check acc doctor for the result.`;
}
