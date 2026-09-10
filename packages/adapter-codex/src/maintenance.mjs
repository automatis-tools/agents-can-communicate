import path from "node:path";
import { openCodexAppServer, parseStableVersion } from "./app-server-client.mjs";
import { socketIsReady } from "./native-endpoint.mjs";
import { absolute, approvedProcessIsDead, failMaintenance, maintenanceContext,
  managedExecutablePaths, metadataExists, probeMaintenanceInstall, readMaintenancePid, runMaintenanceCommand,
  startTimeValid, verifyMaintenanceProcess } from "./maintenance-host.mjs";
import { maintenanceWorkload } from "./maintenance-threads.mjs";

const identityKeys = ["serviceId", "pid", "processStartTime", "codexHome", "cliPath", "cliVersion",
  "serverVersion", "managedPath", "managedVersion", "socketPath"];
const installationKeys = ["codexHome", "cliPath", "cliVersion", "managedPath", "managedVersion", "socketPath"];
const refused = (reasonCode, snapshot) => ({ ok: false, reasonCode, ...(snapshot ? { snapshot } : {}) });
const sameFields = (left, right, fields) => fields.every(key => left?.[key] === right?.[key]);

function validApproval(value) {
  return value?.serviceId === "codex-app-server" && ["ready", "busy"].includes(value.state)
    && Number.isSafeInteger(value.pid) && value.pid > 1 && startTimeValid(value.processStartTime)
    && ["codexHome", "cliPath", "managedPath", "socketPath"].every(key => absolute(value[key]))
    && ["cliVersion", "serverVersion", "managedVersion"].every(key => parseStableVersion(value[key]))
    && value.managedVersion === value.cliVersion
    && managedExecutablePaths(value.codexHome).includes(value.managedPath)
    && value.socketPath === path.join(value.codexHome, "app-server-control/app-server-control.sock");
}

export function sameMaintenanceIdentity(expected, current) {
  return validApproval(expected) && validApproval(current) && sameFields(expected, current, identityKeys);
}

export function createCodexMaintenance({ run = runMaintenanceCommand, open = openCodexAppServer } = {}) {
  async function inspectMaintenance(context) {
    let snapshot = { serviceId: "codex-app-server", state: "unsupported", reasonCode: null,
      pid: null, processStartTime: null, codexHome: null, cliPath: null, cliVersion: null,
      serverVersion: null, managedPath: null, managedVersion: null, socketPath: null,
      busyThreads: 0, queuedRequests: 0 };
    try {
      const paths = await maintenanceContext(context);
      Object.assign(snapshot, { codexHome: paths.codexHome, socketPath: paths.socketPath, managedPath: paths.managedPath });
      if (!await metadataExists(paths.socketPath) && !await metadataExists(paths.pidPath)) return null;
      if (paths.platform !== "darwin-arm64") failMaintenance("maintenance_platform_unsupported");
      if (!await socketIsReady(paths.socketPath)) failMaintenance("daemon_socket_unproven");
      Object.assign(snapshot, await probeMaintenanceInstall(paths, run));
      const version = await run(snapshot.cliPath, ["app-server", "daemon", "version"], paths.options);
      if (version.status !== 0) failMaintenance("daemon_version_unavailable");
      const observed = JSON.parse(version.stdout);
      if (observed.status !== "running" || observed.backend !== "pid") failMaintenance("maintenance_backend_unsupported");
      if (observed.managedCodexPath !== snapshot.managedPath || observed.socketPath !== snapshot.socketPath
        || observed.cliVersion !== snapshot.cliVersion || observed.managedCodexVersion !== snapshot.managedVersion
        || !parseStableVersion(observed.appServerVersion)) failMaintenance("daemon_identity_unavailable");
      snapshot.serverVersion = observed.appServerVersion;
      Object.assign(snapshot, await readMaintenancePid(paths.pidPath));
      await verifyMaintenanceProcess(snapshot, paths, run);
      Object.assign(snapshot, await maintenanceWorkload(snapshot, open));
      const finalPid = await readMaintenancePid(paths.pidPath);
      if (!sameFields(snapshot, finalPid, ["pid", "processStartTime"])) failMaintenance("service_identity_changed");
      await verifyMaintenanceProcess(snapshot, paths, run);
      snapshot.state = snapshot.busyThreads || snapshot.queuedRequests ? "busy" : "ready";
      snapshot.reasonCode = snapshot.state === "busy" ? "service_busy" : null;
    } catch (error) { snapshot.reasonCode = error.reasonCode ?? "maintenance_inspection_failed"; }
    return snapshot;
  }

  async function stopForMaintenance({ context, expected } = {}) {
    let stopAttempted = false;
    const refuseStop = (reasonCode, snapshot) => ({ ...refused(reasonCode, snapshot), stopAttempted });
    if (!validApproval(expected)) return refuseStop("invalid_maintenance_approval");
    try {
      const current = await inspectMaintenance(context);
      if (!sameMaintenanceIdentity(expected, current)) return refuseStop("service_identity_changed", current);
      if (current.state !== "ready" || current.busyThreads !== 0 || current.queuedRequests !== 0) {
        return refuseStop("service_busy", current);
      }
      const paths = await maintenanceContext(context);
      stopAttempted = true;
      const stopped = await run(current.cliPath, ["app-server", "daemon", "stop"], paths.options);
      if (stopped.status !== 0) return refuseStop("daemon_stop_failed");
      if (!await approvedProcessIsDead(expected, paths, run)) return refuseStop("daemon_death_unverified");
      return { ok: true, reasonCode: null, stopAttempted };
    } catch { return refuseStop("daemon_stop_failed"); }
  }

  async function startAfterMaintenance({ context, expected } = {}) {
    if (!validApproval(expected)) return refused("invalid_maintenance_approval");
    try {
      const pinned = { ...context, env: { ...(context?.env ?? process.env), CODEX_HOME: expected.codexHome } };
      const paths = await maintenanceContext(pinned);
      if (paths.platform !== "darwin-arm64") return refused("maintenance_platform_unsupported");
      const install = { ...paths, ...await probeMaintenanceInstall(paths, run) };
      if (!sameFields(expected, install, installationKeys)) return refused("service_identity_changed");
      const existing = await inspectMaintenance(pinned);
      if (existing) {
        if (["ready", "busy"].includes(existing.state) && sameFields(expected, existing, installationKeys)
          && existing.serverVersion === expected.cliVersion) return { ok: true, reasonCode: null, snapshot: existing };
        return refused("service_identity_changed", existing);
      }
      if (!await approvedProcessIsDead(expected, paths, run)) return refused("daemon_death_unverified");
      const started = await run(install.cliPath, ["app-server", "daemon", "start"], paths.options);
      if (started.status !== 0) return refused("daemon_start_failed");
      const current = await inspectMaintenance(pinned);
      if (!current || !["ready", "busy"].includes(current.state)
        || !sameFields(expected, current, installationKeys) || current.serverVersion !== expected.cliVersion) {
        return refused("daemon_start_unverified", current);
      }
      return { ok: true, reasonCode: null, snapshot: current };
    } catch { return refused("daemon_start_failed"); }
  }

  return { inspectMaintenance, stopForMaintenance, startAfterMaintenance };
}
