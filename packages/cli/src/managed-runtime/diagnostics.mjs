import { activationBlockerNotice, listActivationBlockers } from "./activation.mjs";
import { MAINTENANCE_ACTIVE, maintenanceNotice, maintenanceReport, readMaintenance } from "./maintenance-state.mjs";
import { readControl } from "./state.mjs";

/** Available when workspace admission is fenced, and from a newer management
 * implementation before activation. Never opens a workspace or probes clients.
 */
export async function runManagementDoctor({ runtime }) {
  const manager = await readControl(runtime.managerRoot);
  if (!manager) throw new Error("managed update state is unavailable; run acc update to recover");
  const update = await managedUpdateDiagnostic(runtime.managerRoot, manager, manager.active.version);
  return { data: { scope: "update", workspaceInspection: "unavailable_during_update", update,
    remediation: ["acc update"] },
  text: ["Update diagnostics only; workspace and integrations were not inspected.",
    update.notice ?? `ACC ${manager.active.version}; update phase ${manager.phase}.`,
    "Run acc update to finish, then acc doctor for the full workspace report."].join("\n") };
}

export async function managedUpdateDiagnostic(root, manager, running) {
  const blockers = manager.pending ? await listActivationBlockers(root, { ignorePid: process.pid }) : null;
  const update = { checked: false, running, latest: manager.pending?.version ?? null,
    newer: manager.pending !== null, auto: manager.auto, pin: manager.pin,
    pending: manager.pending?.version ?? null, phase: manager.phase,
    notice: blockers === null ? manager.notice : manager.phase === "activating" && !blockers.length
      ? "Integration refresh is incomplete; run acc update to recover."
      : activationBlockerNotice(manager.pending.version, blockers),
    ...(blockers === null ? {} : { holds: blockers.length, blockers }) };
  const maintenance = await readMaintenance(root);
  if (maintenance && (maintenance.target.root === (manager.pending ?? manager.active).root
    || MAINTENANCE_ACTIVE.includes(maintenance.status))) {
    update.maintenance = maintenanceReport(maintenance);
    update.notice = maintenanceNotice(maintenance);
  }
  return update;
}
