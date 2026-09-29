import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareVersions, versionOrder } from "./app-server-client.mjs";

export const MINIMUM_MAINTENANCE_CLI = "0.154.0";
export const absolute = value => typeof value === "string" && path.isAbsolute(value)
  && !/[\0\r\n]/.test(value);
export const failMaintenance = reasonCode => { throw Object.assign(new Error(reasonCode), { reasonCode }); };
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
export const startTimeValid = value => typeof value === "string"
  && /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/.test(value);
// The two packages a Codex daemon runs from, measured. The standalone install
// keeps its PID in app-server.pid (0.154.0-0.159.0); a home with no standalone
// package gets the daemon's own package from `app-server daemon start` on
// 0.157.1 and newer, with its PID in daemon.pid (0.159.0, 2026-09-29). A home
// that has the standalone package keeps using it, so it is looked for first.
const DAEMON_LAYOUTS = Object.freeze([
  { name: "standalone", packageDir: "packages/standalone", executables: ["current/bin/codex", "current/codex"],
    pidFile: "app-server-daemon/app-server.pid" },
  { name: "self-installed", packageDir: "packages/app-server-daemon", executables: ["current/bin/codex"],
    pidFile: "app-server-daemon/daemon.pid" },
]);
export const managedExecutablePaths = codexHome => DAEMON_LAYOUTS.flatMap(layout =>
  layout.executables.map(name => path.join(codexHome, layout.packageDir, name)));

// Where lsof lives: /usr/sbin on macOS, /usr/bin on Linux. A fixed list of
// absolute paths, never PATH, so a directory an operator can write to cannot
// supply the tool that proves socket ownership. The first executable wins;
// none means the socket cannot be proven and verification fails closed.
export const LSOF_CANDIDATES = Object.freeze(["/usr/sbin/lsof", "/usr/bin/lsof"]);

export async function resolveLsof({ access: check = access } = {}) {
  for (const candidate of LSOF_CANDIDATES) {
    try { await check(candidate, constants.X_OK); return candidate; }
    catch { /* the next candidate may be the one this host has */ }
  }
  return null;
}

export function runMaintenanceCommand(command, args, options) {
  return new Promise(resolve => execFile(command, args,
    { timeout: 20_000, ...options, maxBuffer: 131_072, windowsHide: true },
    (error, stdout, stderr) => resolve({ status: error ?
      (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr })));
}

async function canonicalFuturePath(file) {
  const missing = []; let current = file;
  while (true) {
    try { return path.join(await realpath(current), ...missing); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A dangling symlink is an existing unknown destination, not a missing directory.
      if (await metadataExists(current)) failMaintenance("invalid_service_home");
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current)); current = parent;
    }
  }
}

export async function maintenanceContext(context = {}) {
  const env = context.env ?? process.env;
  const home = context.home ?? env.HOME ?? os.homedir();
  let codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
  if (!absolute(home) || !absolute(codexHome)) failMaintenance("invalid_service_home");
  codexHome = await canonicalFuturePath(codexHome);
  const { layout, managedPath } = await installedLayout(codexHome);
  return { codexHome, socketPath: path.join(codexHome, "app-server-control/app-server-control.sock"),
    pidPath: path.join(codexHome, layout.pidFile), layout: layout.name,
    packageDir: path.join(codexHome, layout.packageDir),
    managedPath,
    platform: context.platform ?? `${process.platform}-${process.arch}`,
    options: { cwd: codexHome, env: { ...env, HOME: home, CODEX_HOME: codexHome } } };
}

// The first layout whose executable exists. With none installed, the
// standalone layout's legacy path, which service setup reports as missing.
async function installedLayout(codexHome) {
  for (const layout of DAEMON_LAYOUTS) {
    for (const name of layout.executables) {
      const managedPath = path.join(codexHome, layout.packageDir, name);
      if (await metadataExists(managedPath)) return { layout, managedPath };
    }
  }
  const [standalone] = DAEMON_LAYOUTS;
  return { layout: standalone, managedPath: path.join(codexHome, standalone.packageDir, "current/codex") };
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
  ? /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/.exec(response.stdout)?.[1] ?? null : null;

export async function probeMaintenanceCli(paths, run) {
  const cliPath = await resolveCli(paths.options.env.PATH);
  const version = cliVersion(await run(cliPath, ["--version"], paths.options));
  if (!versionOrder(version) || compareVersions(version, MINIMUM_MAINTENANCE_CLI) < 0) {
    failMaintenance("maintenance_cli_unsupported");
  }
  const help = await run(cliPath, ["app-server", "daemon", "--help"], paths.options);
  if (help.status !== 0 || ["start", "stop", "version"].some(command =>
    !new RegExp(`^\\s+${command}\\s+`, "m").test(help.stdout))) failMaintenance("maintenance_cli_unsupported");
  return { cliPath, cliVersion: version };
}

export async function probeMaintenanceInstall(paths, run) {
  const { cliPath, cliVersion: version } = await probeMaintenanceCli(paths, run);
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

/** Whether `lsof -Fn` output lists a socket at one of these paths. macOS prints
 * the path alone; Linux appends the socket type (`/path type=STREAM`, measured
 * on the ubuntu CI job), and a connected peer may carry more after it. The name
 * is the text before the first ` type=`, compared whole. */
export function socketListedIn(stdout, socketPaths) {
  const names = new Set(typeof socketPaths === "string" ? [socketPaths] : socketPaths);
  return stdout.split("\n").some(line => line.startsWith("n")
    && names.has(line.slice(1).split(" type=")[0]));
}

// The daemon's command line as measured: 0.154.0 ran `<current path> app-server
// --listen unix://`; 0.157.1 runs the resolved releases path with
// `--managed-daemon` appended. The executable must live in the package tree of
// the installed layout and be the managed binary itself, however it is named.
const DAEMON_COMMAND = /^(\/.+?) app-server --listen unix:\/\/(?: --managed-daemon)?$/;

export async function verifyMaintenanceProcess(snapshot, paths, run, { lsof = resolveLsof } = {}) {
  const process = await observeMaintenanceProcess(snapshot.pid, paths, run);
  const executable = DAEMON_COMMAND.exec(process.command ?? "")?.[1] ?? null;
  const packages = (paths.packageDir ?? path.join(paths.codexHome, "packages", "standalone")) + path.sep;
  if (process.state !== "alive" || process.processStartTime !== snapshot.processStartTime
    || executable === null || !executable.startsWith(packages)
    || await realpath(executable).catch(() => null) !== await realpath(paths.managedPath)) {
    failMaintenance("daemon_identity_unavailable");
  }
  // 0.157.1 lists the socket by the path it listens on, not by the symlink it
  // reports; either names the same socket.
  const listening = [paths.socketPath, await realpath(paths.socketPath).catch(() => null)]
    .filter(value => value !== null);
  const lsofPath = await lsof();
  if (lsofPath === null) failMaintenance("daemon_socket_unproven");
  const sockets = await run(lsofPath, ["-n", "-a", "-p", String(snapshot.pid), "-U", "-Fn"], paths.options);
  if (sockets.status !== 0 || !socketListedIn(sockets.stdout, listening)) {
    failMaintenance("daemon_socket_unproven");
  }
}

export async function approvedProcessIsDead(expected, paths, run) {
  const observed = await observeMaintenanceProcess(expected.pid, paths, run);
  return observed.state === "dead" || (observed.state === "alive"
    && observed.processStartTime !== expected.processStartTime);
}
