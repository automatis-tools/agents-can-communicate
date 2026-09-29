import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCodexMaintenance } from "../src/maintenance.mjs";

export async function maintenanceFixture(t, { binLayout = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(
    process.platform === "win32" ? os.tmpdir() : "/tmp", "acc-maint-")));
  const home = path.join(root, "home"), codexHome = path.join(home, ".codex");
  const bin = path.join(root, "bin"), cliPath = path.join(bin, "codex");
  const managedPath = path.join(codexHome, `packages/standalone/current/${binLayout ? "bin/" : ""}codex`);
  const socketPath = path.join(codexHome, "app-server-control/app-server-control.sock");
  const pidPath = path.join(codexHome, "app-server-daemon/app-server.pid");
  // Codex 0.157.1+ in a home with no standalone package installs its own
  // (measured on 0.159.0, 2026-09-29): releases under
  // packages/app-server-daemon, `current` linking the release, PID in daemon.pid.
  const selfRelease = path.join(codexHome, "packages/app-server-daemon/releases/0.159.0-aarch64-apple-darwin");
  const selfManagedPath = path.join(codexHome, "packages/app-server-daemon/current/bin/codex");
  const selfPidPath = path.join(codexHome, "app-server-daemon/daemon.pid");
  const layoutManaged = () => state.layout === "self-installed" ? selfManagedPath : managedPath;
  const layoutPid = () => state.layout === "self-installed" ? selfPidPath : pidPath;
  for (const file of [cliPath, managedPath, socketPath, pidPath]) {
    await mkdir(path.dirname(file), { recursive: true });
  }
  for (const file of [cliPath, managedPath]) { await writeFile(file, "fixture"); await chmod(file, 0o755); }
  if (binLayout) await symlink("bin/codex", path.join(codexHome, "packages/standalone/current/codex"));
  const state = { pid: 45678, processStartTime: "Thu Sep 10 03:15:00 2026", running: false,
    cliVersion: "0.154.0", managedVersion: "0.154.0", serverVersion: "0.153.4",
    threads: [{ id: "private-thread", status: { type: "idle" } }], queued: [],
    processUnknown: false, processCommand: null, socketOwned: true, backend: "pid" };
  let socket;
  const writePid = () => writeFile(layoutPid(), JSON.stringify({ pid: state.pid,
    processStartTime: state.processStartTime }));
  async function start() {
    // Codex 0.155.1 `app-server daemon start` replaces the socket file a
    // stopped service left behind (measured), so the fixture service does too.
    await rm(socketPath, { force: true });
    const listenPath = state.listenPath ?? socketPath;
    // 0.157.1 likewise replaces a stale socket at the path it listens on (measured).
    await rm(listenPath, { force: true });
    if (state.layout === "self-installed") {
      // `daemon start` installs the package from the CLI when it is missing.
      await mkdir(path.join(selfRelease, "bin"), { recursive: true });
      await writeFile(path.join(selfRelease, "bin", "codex"), "fixture", { mode: 0o755 });
      await symlink(selfRelease, path.join(codexHome, "packages/app-server-daemon/current")).catch(error => {
        if (error.code !== "EEXIST") throw error; });
      await mkdir(path.dirname(selfPidPath), { recursive: true });
      state.processCommand = `${await realpath(path.join(selfRelease, "bin", "codex"))} app-server --listen unix:// --managed-daemon`;
    }
    socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(listenPath, resolve); });
    if (listenPath !== socketPath) await symlink(listenPath, socketPath);
    state.running = true; await writePid();
  }
  // Codex 0.157.1, measured 2026-09-26: the control socket path is a symlink to
  // a socket under /private/tmp/codex-daemon-<uid>/<hex>, `current` is a
  // symlink into releases/, and the daemon's command line is
  // `<releases path>/bin/codex app-server --listen unix:// --managed-daemon`.
  async function daemonLayout157() {
    await stop();
    const standalone = path.join(codexHome, "packages/standalone");
    const releases = path.join(standalone, "releases/0.157.1-aarch64-apple-darwin");
    await mkdir(path.dirname(releases), { recursive: true });
    await rename(path.join(standalone, "current"), releases);
    await symlink(releases, path.join(standalone, "current"));
    state.listenPath = path.join(root, "tmp/codex-daemon-501/220dda598ee8");
    await mkdir(path.dirname(state.listenPath), { recursive: true, mode: 0o700 });
    state.processCommand = `${await realpath(managedPath)} app-server --listen unix:// --managed-daemon`;
    await start();
  }
  // A home that never had the standalone package, on a CLI that installs
  // the daemon's own package at its first start.
  async function selfInstalledLayout({ started = true } = {}) {
    await stop();
    await rm(path.join(codexHome, "packages/standalone"), { recursive: true, force: true });
    state.layout = "self-installed";
    state.cliVersion = state.managedVersion = state.serverVersion = "0.159.0";
    if (started) await start();
  }
  async function stop() {
    if (socket) { await new Promise(resolve => socket.close(resolve)); socket = null; }
    state.running = false; await rm(layoutPid(), { force: true });
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await start();
  const context = { home, env: { HOME: home, CODEX_HOME: codexHome, PATH: bin }, platform: "darwin-arm64" };
  const commands = [], requests = [];
  const ok = stdout => ({ status: 0, stdout, stderr: "" });
  const run = async (command, args, options) => {
    if (command === "/bin/ps") {
      if (state.processUnknown) return { status: 1, stdout: "", stderr: "permission denied" };
      if (!state.running || Number(args[1]) !== state.pid) return { status: 1, stdout: "", stderr: "" };
      return ok(`${state.processStartTime} ${state.processCommand ?? `${managedPath} app-server --listen unix://`}\n`);
    }
    // Wherever this host keeps lsof: /usr/sbin on macOS, /usr/bin on Linux.
    if (path.basename(command) === "lsof") return ok(state.socketOwned ? `p${state.pid}\nn${state.listenPath ?? socketPath}\n` : "");
    assert.ok([cliPath, layoutManaged()].includes(command), "never execute an approved job's arbitrary path");
    assert.equal(options.env.CODEX_HOME, codexHome);
    const argsText = args.join(" ");
    if (argsText === "--version") return ok(`codex-cli ${command === cliPath ? state.cliVersion : state.managedVersion}\n`);
    if (argsText === "app-server daemon --help") return ok("Commands:\n  start Start\n  stop Stop\n  restart Restart\n  version Version\n");
    // `codex features list` as 0.158.0 prints it; unset means a CLI without it.
    if (argsText === "features list") {
      return state.featuresList === undefined ? { status: 2, stdout: "", stderr: "unrecognized subcommand" }
        : ok(state.featuresList);
    }
    const action = args.at(-1);
    if (action === "stop") { commands.push(action);
      if (state.stopThrows) throw new Error("private vendor command failure");
      if (state.stopFails) return { status: 1, stdout: "", stderr: "private vendor command failure" };
      await stop();
      if (state.unknownAfterStop) state.processUnknown = true;
      return ok('{"status":"stopped"}\n'); }
    if (action === "start") {
      commands.push(action); state.pid += 1; state.processStartTime = "Thu Sep 10 03:16:00 2026";
      state.serverVersion = state.managedVersion; await start(); return ok('{"status":"started"}\n');
    }
    assert.equal(action, "version");
    if (!state.running) return { status: 1, stdout: "", stderr: "No such file or directory (os error 2)" };
    return ok(JSON.stringify({ status: "running", backend: state.backend, managedCodexPath: layoutManaged(),
      managedCodexVersion: state.managedVersion, socketPath, cliVersion: state.cliVersion,
      appServerVersion: state.serverVersion }));
  };
  const open = async () => ({ notify() {}, close() {}, async request(method, params) {
    requests.push({ method, params });
    if (method === "initialize") return { userAgent: `codex/${state.serverVersion} (Mac OS)` };
    if (method === "thread/loaded/list") return { data: state.threads.map(thread => thread.id), nextCursor: null };
    if (method === "thread/read") {
      assert.equal(params.includeTurns, false, "maintenance must exclude transcript turns");
      return { thread: { ...state.threads.find(thread => thread.id === params.threadId),
        turns: state.turns ?? [], preview: "PRIVATE CONTENT MUST NOT ESCAPE" } };
    }
    if (method === "thread/queue/list") return state.queueResponse ?? { data: state.queued, nextCursor: null };
    if (method === "hooks/list") {
      if (state.hooksError) throw state.hooksError;
      return { data: (params.cwds ?? []).map(cwd => ({ cwd, hooks: state.hooks?.[cwd] ?? [],
        warnings: [], errors: [] })) };
    }
    throw new Error(`Unexpected maintenance RPC: ${method}`);
  } });
  return { ...createCodexMaintenance({ run, open }), context, state, commands, requests,
    root, cliPath, managedPath, codexHome, socketPath, pidPath, writePid, stop, start, daemonLayout157, run, open,
    selfManagedPath, selfPidPath, selfInstalledLayout };
}
