import { verifyManagedCommands } from "./codex-managed-commands.mjs";
import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const DRIVER = fileURLToPath(new URL("./codex-local-daemon-client.py", import.meta.url));
const STANDARD_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const prerequisite = (message, cause) => new Error(`prerequisite: ${message}`, { cause });

export function buildClientEnvironment({ inherited, codex, toolDir, home, codexHome }) {
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !key.startsWith("ACC_") && !key.startsWith("CODEX_")
      && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
  return { ...clean, ACC_NO_UPDATE_CHECK: "1", HOME: home, CODEX_HOME: codexHome,
    PATH: [path.dirname(codex), toolDir, ...STANDARD_PATH].join(":"),
    ZDOTDIR: home, SHELL: "/bin/zsh", TERM: "xterm-256color" };
}

export async function resolveExecutable(name, searchPath = process.env.PATH ?? "") {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate);
  }
  return null;
}

export async function prerequisiteChecks({ tarball, codex, python, driverFile = DRIVER }) {
  const regular = async (file, message, executable = false) => {
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("not a file");
      if (executable) await access(file, constants.X_OK);
    } catch (error) { throw prerequisite(message, error); }
  };
  await regular(tarball, "candidate tarball unavailable");
  await regular(codex, "supplied Codex binary unavailable", true);
  await regular(python, "Python PTY support unavailable", true);
  try {
    await execute(python, [driverFile, "--probe"], { timeout: 5_000 });
  } catch (error) { throw prerequisite("Python PTY support unavailable", error); }
}

export async function prepareOwnedTools({ toolDir, npm, node = process.execPath, python }) {
  await mkdir(toolDir, { recursive: true });
  const tools = { node, npm, ...(python === undefined ? {} : { python3: python }) };
  for (const [name, target] of Object.entries(tools)) {
    if (typeof target !== "string" || target === "") throw prerequisite(`${name} unavailable`);
    await symlink(target, path.join(toolDir, name));
  }
}

export async function verifyInstalledTarget(candidate, { packageRoot, label }) {
  const [target, root] = await Promise.all([realpath(candidate), realpath(packageRoot)]);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside isolated npm prefix: ${target}`);
  }
  return target;
}

const quotedValue = (text, name) => text.match(new RegExp(`^${name}="([^"]+)"$`, "m"))?.[1] ?? null;

export async function verifyInstalledCommands({ hook, skill, packageRoot, hookManifest, dataHome }) {
  const hookText = await readFile(hook, "utf8");
  const skillText = await readFile(skill, "utf8");
  const managed = dataHome === undefined ? null : await verifyManagedCommands({ packageRoot, dataHome });
  const verifyCommand = async (candidate, kind, label) => {
    if (managed) {
      const target = await realpath(candidate);
      if (target !== managed[kind]) throw new Error(`${label} does not target the verified managed launcher`);
      return target;
    }
    return verifyInstalledTarget(candidate, { packageRoot, label });
  };
  const hookRunner = await verifyCommand(quotedValue(hookText, "ACC_RUNNER"), "acc-hook", "hook runner");
  const candidates = [...skillText.matchAll(/["']([^"'\n]*\/acc\.mjs)["']/g)].map(match => match[1]);
  if (candidates.length === 0) throw new Error("installed skill has no absolute ACC command");
  const resolved = await Promise.all(candidates.map(candidate => verifyCommand(candidate, "acc", "skill CLI")));
  if (new Set(resolved).size !== 1) throw new Error("installed skill has inconsistent ACC command targets");
  if (hookManifest !== undefined) {
    const manifest = JSON.parse(await readFile(hookManifest, "utf8"));
    const commands = Object.values(manifest.hooks ?? {}).flatMap(entries => entries)
      .flatMap(entry => entry.hooks ?? []).map(entry => entry.command);
    if (commands.length === 0 || commands.some(command => !command.includes(`'${hook}'`))) {
      throw new Error("generated hook command does not target the isolated installed shim");
    }
  }
  const source = candidates[0];
  const commandLine = skillText.split("\n").find(line => line.includes(source));
  if (commandLine === undefined) throw new Error("installed skill command line is unavailable");
  const end = commandLine.indexOf(source) + source.length + 1;
  return { hookRunner, skillCli: resolved[0], skillCommand: commandLine.slice(0, end) };
}

export function createPtyDriver({ python, driverFile = DRIVER } = {}) {
  const child = spawn(python, [driverFile], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let nextId = 0;
  let closePromise;
  const fail = error => {
    for (const request of pending.values()) {
      clearTimeout(request.timer); request.reject(error ?? new Error("PTY driver closed"));
    }
    pending.clear();
  };
  createInterface({ input: child.stdout }).on("line", line => {
    let reply;
    try { reply = JSON.parse(line); } catch { fail(new Error("PTY driver returned invalid JSON")); return; }
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id); clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(`PTY control: ${reply.error}`));
    else request.resolve(reply.result);
  });
  child.on("error", fail);
  child.on("exit", () => fail(new Error("PTY driver closed")));
  const request = command => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error("PTY driver closed")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("PTY control deadline")); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, error => {
      if (!error) return;
      pending.delete(id); clearTimeout(timer); reject(error);
    });
  });
  const waitExit = async timeoutMs => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return Promise.race([new Promise(resolve => child.once("exit", () => resolve(true))),
      delay(timeoutMs).then(() => false)]);
  };
  const close = () => closePromise ??= (async () => {
    let shutdown = false;
    try { shutdown = (await request({ action: "shutdown" })).cleaned === true; } catch { /* reaping continues */ }
    child.stdin.end();
    let exited = await waitExit(4_000);
    if (!exited) { child.kill("SIGTERM"); exited = await waitExit(4_000); }
    if (!exited) { child.kill("SIGKILL"); exited = await waitExit(4_000); }
    if (!shutdown || !exited) throw new Error("PTY driver shutdown was not acknowledged and reaped");
    return { shutdown, exited };
  })();
  return { request, close, pid: child.pid };
}
