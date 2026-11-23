// One isolated client environment for the measurements that run real clients
// (#135): a copy of a signed-in HOME, ACC installed from a tarball into its own
// npm prefix, its own ACC data home and a new Git project. Closing it stops
// every process started under it and removes it.
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function spawned(command, args, { cwd, env, timeoutMs = 600_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Every process started under `root` that is still running: a daemon, a worker. */
async function stopLeftovers(root) {
  const { stdout } = await execute("ps", ["-axo", "pid=,command="]);
  for (const line of stdout.split("\n")) {
    const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
    if (pid !== undefined && Number(pid) !== process.pid && command.includes(root)) {
      try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ }
    }
  }
}

export async function openFixture({ id, tarball, templateHome, extraEnv = {} }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `acc-measure-${id}-`)));
  const dirs = Object.fromEntries(["home", "prefix", "data", "texts", "project", "npm"]
    .map(name => [name, path.join(root, name)]));
  await cp(templateHome, dirs.home, { recursive: true, verbatimSymlinks: true });
  for (const name of ["prefix", "data", "texts", "project"]) await mkdir(dirs[name], { recursive: true });
  const env = { HOME: dirs.home, USER: os.userInfo().username, LANG: "en_US.UTF-8", TERM: "dumb",
    TMPDIR: os.tmpdir(), PATH: [path.join(dirs.prefix, "bin"), process.env.PATH].join(":"),
    ACC_DATA_HOME: dirs.data, ACC_NO_UPDATE_CHECK: "1", ACC_PARTICIPANT: "measured",
    npm_config_cache: dirs.npm, ...extraEnv };
  const acc = path.join(dirs.prefix, "bin", "acc");
  const fixture = {
    root, dirs, env, acc,
    packageRoot: path.join(dirs.prefix, "lib", "node_modules", "agents-can-communicate"),
    /** An ACC CLI call in the project, as a participant when `credentials` are given. */
    cli: (args, credentials = []) => execute(acc, [...args, ...credentials, "--cwd", dirs.project, "--json"],
      { env, cwd: dirs.project }).then(({ stdout }) => JSON.parse(stdout).data),
    /** A manual participant, returned as its credential arguments. */
    attach: async name => {
      const attached = await fixture.cli(["attach", "--participant", name]);
      return ["--session", attached.sessionId, "--generation", attached.generation];
    },
    // No terminal: the installer takes its defaults, as a scripted install does.
    install: async () => {
      const done = await spawned(acc, ["install", "--adapter", id], { env, cwd: dirs.project });
      if (done.code !== 0) throw new Error(`acc install ${id}: ${done.stderr || done.stdout}`);
    },
    uninstall: async () => {
      const done = await spawned(acc, ["uninstall", "--adapter", id], { env, cwd: dirs.project });
      if (done.code !== 0) throw new Error(`acc uninstall ${id}: ${done.stderr || done.stdout}`);
    },
    close: async ({ keep = false } = {}) => {
      if (id === "codex") await spawned("codex", ["app-server", "daemon", "stop"], { cwd: root,
        env: { ...env, CODEX_HOME: path.join(dirs.home, ".codex") }, timeoutMs: 30_000 }).catch(() => null);
      await stopLeftovers(root);
      if (!keep) await rm(root, { recursive: true, force: true });
    },
  };
  try {
    await execute("git", ["init", "-q", dirs.project], { env });
    await execute("npm", ["install", "-g", "--silent", "--prefix", dirs.prefix, tarball], { env });
  } catch (error) {
    await fixture.close();
    throw error;
  }
  return fixture;
}
