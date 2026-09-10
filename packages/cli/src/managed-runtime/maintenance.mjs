import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ALL_ADAPTERS } from "../install-command.mjs";
import { listActivationBlockers } from "./activation.mjs";
import { confirmedDead, withManagerLock } from "./mutex.mjs";
import { readControl, readManagedJson } from "./state.mjs";
import { MAINTENANCE_ACTIVE, maintenanceNotice, maintenanceRecipe, maintenanceReport,
  readMaintenance, writeMaintenance } from "./maintenance-state.mjs";

export function maintenanceContext(control, env) {
  return { home: control.home, env, platform: `${process.platform}-${process.arch}` };
}

export async function inspectMaintenanceServices({ control, env = process.env, root, adapters = ALL_ADAPTERS() }) {
  // Maintenance targets the pending generation when one exists (its contract
  // is what activation will judge holds against), otherwise the active one:
  // there is no incoming generation, only a stale daemon to bring in line
  // with what is already running. Same fallback as this file's own `target`
  // below: pick the whole generation record, not a per-field fallback, so a
  // pending generation that declares no contract of its own is judged as
  // "none" and not silently swapped for the active generation's.
  const blockers = await listActivationBlockers(root, { ignorePid: process.pid,
    incomingStoreVersion: (control.pending ?? control.active).storeVersion });
  const services = [];
  for (const adapter of adapters.filter(a => control.targets.includes(a.id) && a.inspectMaintenance)) {
    const snapshot = await adapter.inspectMaintenance(maintenanceContext(control, env));
    if (!snapshot || !["ready", "busy"].includes(snapshot.state)) continue;
    if (snapshot.serverVersion !== snapshot.cliVersion
      || blockers.some(b => b.pid === snapshot.pid && b.kinds.includes("native"))) {
      services.push({ adapterId: adapter.id, snapshot });
    }
  }
  return services;
}

export async function spawnMaintenance({ root, job, packageRoot, env }) {
  packageRoot = job.workerRoot ?? packageRoot;
  const manifest = await readManagedJson(path.join(packageRoot, "package.json"));
  if (manifest?.name !== "agents-can-communicate" || manifest.accManagedUpdateProtocol !== 2) {
    throw new Error("maintenance worker implementation is unavailable");
  }
  const child = spawn(process.execPath, [path.join(packageRoot, "bin", "acc-maintenance-worker.mjs"), root, job.id],
    { env, cwd: root, detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return child.pid;
}

const response = job => ({ data: { reason: "maintenance_pending", maintenance: maintenanceReport(job) }, text: maintenanceNotice(job) });

async function launch(root, job, runtime) {
  if (job.workerPid !== null && !await confirmedDead(job.workerPid)) return job;
  try {
    // The child reads after publication; a separate lifetime lock prevents a
    // second command from creating two workers or overwriting its checkpoint.
    const workerPid = await (runtime.spawnMaintenance ?? spawnMaintenance)({ root, job,
      packageRoot: runtime.packageRoot, env: runtime.env ?? process.env });
    return writeMaintenance(root, { ...job, workerPid });
  } catch {
    return writeMaintenance(root, { ...job, status: job.attempted.length ? "recovery" : "failed",
      reasonCode: "maintenance_worker_start_failed" });
  }
}

/** Explicit command only. Background inspection never grants restart consent. */
export async function requestMaintenance({ root, control, options, runtime, services }) {
  const existing = await readMaintenance(root);
  if (existing && MAINTENANCE_ACTIVE.includes(existing.status)) {
    return withManagerLock(root, async () => {
      const latest = await readMaintenance(root);
      if (!latest || !MAINTENANCE_ACTIVE.includes(latest.status)) return latest ? response(latest) : null;
      return response(await launch(root, latest, runtime));
    });
  }
  services ??= await inspectMaintenanceServices({ root, control, env: runtime.env, adapters: runtime.adapters });
  if (services.length !== 1) return null; // More than one service needs a separate captured contract.
  const names = services.map(s => s.snapshot.serviceId).join(", ");
  if (!options.yes) {
    if (options.json || runtime.isInteractive?.() !== true) return {
      data: { reason: "confirmation_required", services: services.map(s => ({ adapterId: s.adapterId, serviceId: s.snapshot.serviceId })) },
      text: `Finishing the update requires restarting ${names}, disconnecting open clients. Run acc update in a terminal to confirm, or acc update --yes to consent explicitly.` };
    const approved = await runtime.confirm?.(`Restart ${names} to finish updating ACC? Open clients will disconnect; ACC will wait for idle turns, refresh integrations, restart the service and verify it. A turn started during the final restart check can be interrupted.`,
      { input: runtime.input, output: runtime.output });
    if (approved !== true) return { data: { reason: "maintenance_declined" },
      text: "Client restart declined; the update remains pending until running clients exit." };
  }
  return withManagerLock(root, async () => {
    const current = await readControl(root), previous = await readMaintenance(root);
    if (previous && MAINTENANCE_ACTIVE.includes(previous.status)) return response(previous);
    if (maintenanceRecipe(current) !== maintenanceRecipe(control)) return {
      data: { reason: "state_changed" }, text: "Update settings changed before confirmation; run acc update again." };
    const job = await writeMaintenance(root, { schemaVersion: 1, id: randomUUID(), status: "waiting",
      target: current.pending ?? current.active, recipe: maintenanceRecipe(current), services,
      workerRoot: runtime.packageRoot,
      approvedAt: new Date().toISOString(), deadline: Date.now() + 15 * 60_000,
      callerPid: process.pid, workerPid: null, attempted: [], reasonCode: null });
    return response(await launch(root, job, runtime));
  });
}
