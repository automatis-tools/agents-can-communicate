import { activationBlockerNotice, listActivationBlockers } from "./activation.mjs";
import { MAINTENANCE_ACTIVE, maintenanceNotice, maintenanceReport, readMaintenance } from "./maintenance-state.mjs";
import { readControl } from "./state.mjs";
import { DENIED_GUIDANCE, deniedStateText } from "./admission.mjs";

/** Available when workspace admission is fenced, and from a newer management
 * implementation before activation. Never opens a workspace or probes clients.
 */
export async function runManagementDoctor({ runtime }) {
  const manager = await readControl(runtime.managerRoot);
  if (!manager) throw new Error("managed update state is unavailable; run acc update to recover");
  const update = await managedUpdateDiagnostic(runtime.managerRoot, manager, manager.active.version);
  // Admission failed because this process may not write ACC's state (#316):
  // the update state is reported as it is, and the remedy is access.
  if (runtime.admission?.reasonCode === "state_access_denied") {
    const finish = manager.pending ? [`then run acc update there to finish ACC ${manager.pending.version}`] : [];
    return { data: { scope: "runtime", workspaceInspection: "state_access_denied", admission: runtime.admission,
      update, remediation: [DENIED_GUIDANCE, ...finish] },
    text: ["Runtime diagnostics only; ACC could not write its state, so the workspace was not inspected.",
      `${deniedStateText(runtime.admission, manager)}.`, `${DENIED_GUIDANCE}.`, ...finish].join("\n") };
  }
  return { data: { scope: "update", workspaceInspection: "unavailable_during_update", update,
    remediation: ["acc update"] },
  text: ["Update diagnostics only; workspace and integrations were not inspected.",
    update.notice ?? `ACC ${manager.active.version}; update phase ${manager.phase}.`,
    "Run acc update to finish, then acc doctor for the full workspace report."].join("\n") };
}

export async function managedUpdateDiagnostic(root, manager, running) {
  const blockers = manager.pending ? await listActivationBlockers(root, { ignorePid: process.pid,
    incomingStoreVersion: manager.pending.storeVersion }) : null;
  const update = { checked: false, running, latest: manager.pending?.version ?? null,
    newer: manager.pending !== null, auto: manager.auto, pin: manager.pin,
    pending: manager.pending?.version ?? null, phase: manager.phase,
    notice: blockers === null ? manager.notice : manager.phase === "activating" && !blockers.length
      ? "Integration refresh is incomplete; run acc update to recover."
      : activationBlockerNotice(manager.pending.version, blockers),
    ...(blockers === null ? {} : { holds: blockers.length, blockers }) };
  const maintenance = await readMaintenance(root);
  // A job that failed or was cancelled for the release that is now active is
  // history: another path activated it, and "run acc update to retry" asked
  // for an update already done (#281). A completed job still reports its restart.
  const settled = maintenance && manager.pending === null && maintenance.target.root === manager.active.root
    && ["failed", "cancelled"].includes(maintenance.status);
  if (maintenance && !settled && (maintenance.target.root === (manager.pending ?? manager.active).root
    || MAINTENANCE_ACTIVE.includes(maintenance.status))) {
    update.maintenance = maintenanceReport(maintenance);
    update.notice = maintenanceNotice(maintenance);
  }
  return update;
}
