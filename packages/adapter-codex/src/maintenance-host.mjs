import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareStableVersions, parseStableVersion } from "./app-server-client.mjs";

export const MINIMUM_MAINTENANCE_CLI = "0.154.0";
export const absolute = value => typeof value === "string" && path.isAbsolute(value)
  && !/[\0\r\n]/.test(value);
export const failMaintenance = reasonCode => { throw Object.assign(new Error(reasonCode), { reasonCode }); };
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
export const startTimeValid = value => typeof value === "string"
  && /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/.test(value);
export const managedExecutablePaths = codexHome => ["bin/codex", "codex"].map(name =>
  path.join(codexHome, "packages/standalone/current", name));

export function runMaintenanceCommand(command, args, options) {
  return new Promise(resolve => execFile(command, args,
    { ...options, timeout: 20_000, maxBuffer: 131_072, windowsHide: true },
    (error, stdout, stderr) => resolve({ status: error ?
      (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr })));
}

export async function maintenanceContext(context = {}) {
  const env = context.env ?? process.env;
  const home = context.home ?? env.HOME ?? os.homedir();
  let codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
  if (!absolute(home) || !absolute(codexHome)) failMaintenance("invalid_service_home");
  try { codexHome = await realpath(codexHome); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const [binPath, legacyPath] = managedExecutablePaths(codexHome);
  const managedPath = await metadataExists(binPath) ? binPath : legacyPath;
  return { codexHome, socketPath: path.join(codexHome, "app-server-control/app-server-control.sock"),
    pidPath: path.join(codexHome, "app-server-daemon/app-server.pid"),
    managedPath,
    platform: context.platform ?? `${process.platform}-${process.arch}`,
    options: { cwd: codexHome, env: { ...env, HOME: home, CODEX_HOME: codexHome } } };
}

export async function metadataExists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function resolveCli(pathEnv) {
  for (const directory of String(pathEnv ?? "").split(path.delimiter)) {
    if (!absolute(directory)) continue;
    const candidate = path.join(directory, "codex");
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      if ((await lstat(resolved)).isFile()) return resolved;
    } catch { /* another PATH entry may be usable */ }
  }
  failMaintenance("maintenance_cli_unavailable");
}

const cliVersion = response => response.status === 0
  ? /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(response.stdout)?.[1] ?? null : null;

export async function probeMaintenanceInstall(paths, run) {
  const cliPath = await resolveCli(paths.options.env.PATH);
  const version = cliVersion(await run(cliPath, ["--version"], paths.options));
  if (!parseStableVersion(version) || compareStableVersions(version, MINIMUM_MAINTENANCE_CLI) < 0) {
    failMaintenance("maintenance_cli_unsupported");
  }
  const help = await run(cliPath, ["app-server", "daemon", "--help"], paths.options);
  if (help.status !== 0 || ["start", "stop", "version"].some(command =>
    !new RegExp(`^\\s+${command}\\s+`, "m").test(help.stdout))) failMaintenance("maintenance_cli_unsupported");
  const managedVersion = cliVersion(await run(paths.managedPath, ["--version"], paths.options));
  if (managedVersion !== version) failMaintenance("managed_binary_mismatch");
  return { cliPath, cliVersion: version, managedVersion };
}

export async function readMaintenancePid(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > 4_096 || (info.mode & 0o022) !== 0) {
      failMaintenance("daemon_identity_unavailable");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!Number.isSafeInteger(value.pid) || value.pid < 2 || !startTimeValid(value.processStartTime)) {
      failMaintenance("daemon_identity_unavailable");
    }
    return { pid: value.pid, processStartTime: value.processStartTime };
  } finally { await handle?.close(); }
}

export async function observeMaintenanceProcess(pid, paths, run) {
  const response = await run("/bin/ps", ["-p", String(pid), "-o", "lstart=,command="], paths.options);
  if (response.status === 1 && response.stdout === "" && response.stderr === "") return { state: "dead" };
  if (response.status !== 0) return { state: "unknown" };
  const match = /^(.{24})\s+(.+)$/.exec(response.stdout.trim());
  if (!match || !startTimeValid(match[1])) return { state: "unknown" };
  return { state: "alive", processStartTime: match[1], command: match[2] };
}

export async function verifyMaintenanceProcess(snapshot, paths, run) {
  const process = await observeMaintenanceProcess(snapshot.pid, paths, run);
  const suffix = " app-server --listen unix://";
  const executable = process.command?.endsWith(suffix) ? process.command.slice(0, -suffix.length) : null;
  if (process.state !== "alive" || process.processStartTime !== snapshot.processStartTime
    || !managedExecutablePaths(paths.codexHome).includes(executable)
    || await realpath(executable) !== await realpath(paths.managedPath)) {
    failMaintenance("daemon_identity_unavailable");
  }
  const sockets = await run("/usr/sbin/lsof", ["-n", "-a", "-p", String(snapshot.pid), "-U", "-Fn"], paths.options);
  if (sockets.status !== 0 || !sockets.stdout.split("\n").includes(`n${paths.socketPath}`)) {
    failMaintenance("daemon_socket_unproven");
  }
}

export async function approvedProcessIsDead(expected, paths, run) {
  const observed = await observeMaintenanceProcess(expected.pid, paths, run);
  return observed.state === "dead" || (observed.state === "alive"
    && observed.processStartTime !== expected.processStartTime);
}
