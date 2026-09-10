import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  const writePid = () => writeFile(pidPath, JSON.stringify({ pid: state.pid,
    processStartTime: state.processStartTime }));
  async function start() {
    socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(socketPath, resolve); });
    state.running = true; await writePid();
  }
  async function stop() {
    if (socket) { await new Promise(resolve => socket.close(resolve)); socket = null; }
    state.running = false; await rm(pidPath, { force: true });
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
    if (command === "/usr/sbin/lsof") return ok(state.socketOwned ? `p${state.pid}\nn${socketPath}\n` : "");
    assert.ok([cliPath, managedPath].includes(command), "never execute an approved job's arbitrary path");
    assert.equal(options.env.CODEX_HOME, codexHome);
    const argsText = args.join(" ");
    if (argsText === "--version") return ok(`codex-cli ${command === cliPath ? state.cliVersion : state.managedVersion}\n`);
    if (argsText === "app-server daemon --help") return ok("Commands:\n  start Start\n  stop Stop\n  restart Restart\n  version Version\n");
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
    return ok(JSON.stringify({ status: "running", backend: state.backend, managedCodexPath: managedPath,
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
    throw new Error(`Unexpected maintenance RPC: ${method}`);
  } });
  return { ...createCodexMaintenance({ run, open }), context, state, commands, requests,
    root, cliPath, managedPath, codexHome, socketPath, pidPath, writePid, stop, start };
}
