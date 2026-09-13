import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { socketIsReady } from "./native-endpoint.mjs";
import { probeNativeDelivery } from "./native-delivery.mjs";
import { installCodexStandalone } from "./standalone-install.mjs";
import { failMaintenance, maintenanceContext, probeMaintenanceCli, probeMaintenanceInstall,
  readMaintenancePid, runMaintenanceCommand, verifyMaintenanceProcess } from "./maintenance-host.mjs";

const keys = ["home", "codexHome", "cliPath", "cliVersion", "managedPath", "managedVersion",
  "managedRealPath", "cliIdentity", "managedIdentity", "socketPath", "pidPath", "platform"];
const prerequisiteKeys = ["home", "codexHome", "cliPath", "cliVersion", "cliIdentity", "socketPath", "pidPath", "platform"];
const same = (a, b, fields = keys) => fields.every(key => a?.[key] === b?.[key]);
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
const sessionNeeded = "Codex service ready; open a new Codex session to establish its delivery binding and review client hooks and permissions";
const diagnostics = {
  native_endpoint_unavailable: "Prepare the missing Codex service with codex app-server daemon start, then open a new Codex session",
  managed_install_missing: "Codex service needs its standalone package; run acc install to download the matching official Codex release and prepare the service",
  managed_install_incomplete: "Codex standalone installation is incomplete; repair it with the official Codex installer, then retry acc install",
  prerequisite_consent_required: "Codex standalone download was not approved. Run acc install --adapter codex --delivery actionable to allow the download and automatic peer requests",
  prerequisite_download_failed: "Could not download the official Codex installer; check your connection and retry acc install",
  prerequisite_integrity_failed: "The Codex installer checksum did not match the reviewed version; no installer was run",
  prerequisite_install_failed: "The official Codex installation did not complete; check connectivity and the selected Codex home, then retry acc install",
  managed_binary_mismatch: "Codex CLI and managed standalone versions differ; repair the vendor installation, then retry acc install",
  maintenance_platform_unsupported: "Codex service preparation is captured only on darwin-arm64; configure the vendor service manually",
  maintenance_cli_unsupported: "Codex cold service preparation requires codex-cli 0.154.0 or newer with daemon commands; update the vendor installation, then retry acc install",
};
function report(state, reasonCode, facts = {}) {
  return { ...facts, state, reasonCode, diagnostic: state === "ready"
    ? reasonCode === "native_session_unavailable" ? sessionNeeded
      : "Codex service infrastructure is ready; current session binding is reported separately"
    : diagnostics[reasonCode] ?? `Codex service preparation could not verify ${reasonCode}; inspect the vendor service and retry acc install` };
}

export function createCodexServiceSetup({ run = runMaintenanceCommand, probe = probeNativeDelivery,
  fs = { lstat, realpath }, contextPaths = maintenanceContext,
  installStandalone = installCodexStandalone } = {}) {
  async function info(file) {
    try { return await fs.lstat(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function safeDirectories(paths) {
    for (const dir of [paths.codexHome, path.dirname(paths.socketPath), path.dirname(paths.pidPath)]) {
      const stat = await info(dir);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || !own(stat) || (stat.mode & 0o022))) {
        failMaintenance("unsafe_service_directory");
      }
    }
  }
  async function executableIdentity(file) {
    const resolved = await fs.realpath(file), stat = await fs.lstat(resolved);
    if (!stat.isFile() || !own(stat) || (stat.mode & 0o022)) failMaintenance("unsafe_service_executable");
    return { resolved, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  }
  async function installed(paths) {
    await safeDirectories(paths);
    if (!await info(paths.managedPath)) failMaintenance("managed_install_missing");
    const installation = await probeMaintenanceInstall(paths, run);
    const cli = await executableIdentity(installation.cliPath);
    const managed = await executableIdentity(paths.managedPath);
    return { home: paths.options.env.HOME, codexHome: paths.codexHome,
      managedPath: paths.managedPath, managedRealPath: managed.resolved,
      cliIdentity: cli.identity, managedIdentity: managed.identity,
      socketPath: paths.socketPath, pidPath: paths.pidPath, platform: paths.platform, ...installation };
  }
  async function missingPrerequisite(paths) {
    for (const name of ["packages", "packages/standalone", "packages/standalone/bin", "packages/standalone/releases"]) {
      const stat = await info(path.join(paths.codexHome, name));
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || !own(stat) || (stat.mode & 0o022))) {
        failMaintenance("unsafe_service_directory");
      }
    }
    if (await info(path.join(paths.codexHome, "packages/standalone/current"))) failMaintenance("managed_install_incomplete");
    if (await info(paths.pidPath) || await info(paths.socketPath)) failMaintenance("daemon_identity_unavailable");
    const installation = await probeMaintenanceCli({ ...paths,
      options: { ...paths.options, cwd: paths.options.env.HOME } }, run);
    const cli = await executableIdentity(installation.cliPath);
    return report("needed", "managed_install_missing", { requiresInstall: true,
      home: paths.options.env.HOME, codexHome: paths.codexHome, cliIdentity: cli.identity,
      socketPath: paths.socketPath, pidPath: paths.pidPath, platform: paths.platform, ...installation });
  }
  async function verify(paths, facts) {
    if (!await socketIsReady(paths.socketPath)) failMaintenance("daemon_socket_unproven");
    const version = await run(facts.cliPath, ["app-server", "daemon", "version"], paths.options);
    if (version.status !== 0) failMaintenance("daemon_version_unavailable");
    const observed = JSON.parse(version.stdout);
    if (observed.status !== "running" || observed.backend !== "pid") failMaintenance("maintenance_backend_unsupported");
    if (observed.managedCodexPath !== facts.managedPath || observed.socketPath !== facts.socketPath
      || observed.cliVersion !== facts.cliVersion || observed.managedCodexVersion !== facts.managedVersion
      || observed.appServerVersion !== facts.cliVersion) failMaintenance("daemon_identity_unavailable");
    const pid = await readMaintenancePid(paths.pidPath);
    await verifyMaintenanceProcess(pid, paths, run);
    const native = await probe({ env: paths.options.env, timeoutMs: 1_500 });
    // native_session_unavailable is emitted only after initialize and a valid,
    // empty loaded-thread list. It proves infrastructure, never a bound recipient.
    if ((!native.supported && native.reasonCode !== "native_session_unavailable")
      || native.clientVersion !== facts.cliVersion) failMaintenance("daemon_protocol_unverified");
    if (!same(pid, await readMaintenancePid(paths.pidPath), ["pid", "processStartTime"])) {
      failMaintenance("service_identity_changed");
    }
    await verifyMaintenanceProcess(pid, paths, run);
    return report("ready", native.reasonCode ?? null, { ...facts, ...pid });
  }
  async function inspect(context, { strict = false } = {}) {
    try {
      const paths = await contextPaths(context);
      if (paths.platform !== "darwin-arm64") failMaintenance("maintenance_platform_unsupported");
      if (!strict) {
        const native = await probe({ env: paths.options.env, timeoutMs: 1_500 });
        // Preserve the existing delivery support matrix: a healthy older
        // service needs no new managed-install or cold-start prerequisite.
        if (native.supported) return report("ready", native.reasonCode ?? null);
      }
      await safeDirectories(paths);
      if (!await info(paths.managedPath)) return await missingPrerequisite(paths);
      const facts = await installed(paths);
      if (!await info(paths.socketPath) && !await info(paths.pidPath)) {
        return report("needed", "native_endpoint_unavailable", facts);
      }
      return await verify(paths, facts);
    } catch (error) {
      const reason = error.reasonCode ?? "service_inspection_failed";
      return report(reason.endsWith("_unsupported") ? "unsupported" : "blocked", reason);
    }
  }
  async function preparePrerequisite(context, plan, consent) {
    let attempted = false;
    try {
      if (consent !== true) failMaintenance("prerequisite_consent_required");
      if (plan.state !== "needed" || !prerequisiteKeys.every(key => typeof plan[key] === "string")) {
        failMaintenance("invalid_service_setup_plan");
      }
      const beforeInstall = async () => {
        const current = await inspect(context, { strict: true });
        if (current.state !== "needed" || current.requiresInstall !== true
          || !same(plan, current, prerequisiteKeys)) failMaintenance("service_identity_changed");
      };
      await beforeInstall();
      attempted = true;
      await installStandalone(plan, { env: context?.env ?? process.env, beforeInstall });
      const next = await inspect(context, { strict: true });
      if (!["needed", "ready"].includes(next.state) || next.requiresInstall
        || !same(plan, next, prerequisiteKeys)) failMaintenance("service_identity_changed");
      const result = await prepareNativeServiceSetup({ context, plan: next });
      return { ...result, installedPrerequisite: true };
    } catch (error) {
      return { ...report(attempted ? "failed" : "blocked", error.reasonCode ?? "prerequisite_install_failed"),
        started: false, installedPrerequisite: false };
    }
  }
  async function prepareNativeServiceSetup({ context, plan, installPrerequisites } = {}) {
    if (plan?.requiresInstall === true) return preparePrerequisite(context, plan, installPrerequisites);
    let started = false;
    try {
      if (plan?.state === "ready") {
        const current = await inspect(context);
        return { ...current, state: current.state === "ready" ? "ready" : "blocked", started };
      }
      if (plan?.state !== "needed" || !keys.every(key => typeof plan[key] === "string")) {
        return { ...report("blocked", "invalid_service_setup_plan"), started };
      }
      // Do not substitute approved paths into context: detect changed HOME,
      // CODEX_HOME, PATH or managed-current targets before any start command.
      const current = await inspect(context, { strict: true });
      if (!same(plan, current)) return { ...report("blocked", "service_identity_changed"), started };
      if (current.state === "ready") return { ...current, started };
      if (current.state !== "needed") return { ...current, state: "blocked", started };
      const paths = await contextPaths(context);
      if (!same(plan, await installed(paths))) failMaintenance("service_identity_changed");
      // Last check immediately before the only mutating command. Never delete
      // stale metadata or stop/restart a process on this path.
      if (await info(paths.socketPath) || await info(paths.pidPath)) {
        return { ...await verify(paths, current), started };
      }
      started = true;
      const result = await run(plan.cliPath, ["app-server", "daemon", "start"], {
        cwd: plan.codexHome, env: { ...(context?.env ?? process.env), HOME: plan.home, CODEX_HOME: plan.codexHome },
        timeout: 15_000,
      });
      if (result.status !== 0) failMaintenance("daemon_start_failed");
      if (!same(plan, await installed(paths))) failMaintenance("service_identity_changed");
      return { ...await verify(paths, current), started };
    } catch (error) {
      return { ...report(started ? "failed" : "blocked", error.reasonCode ?? "daemon_start_failed"), started };
    }
  }
  return { inspectNativeServiceSetup: context => inspect(context), prepareNativeServiceSetup };
}
