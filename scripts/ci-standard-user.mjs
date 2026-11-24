// Run one command on a Windows CI runner as a standard (non-elevated) local
// user, and relay its output and exit code.
//
// The runner's own account holds an elevated token, and Codex refuses to start
// its app-server daemon with one. A person's machine runs it as a standard user,
// so the live-delivery check has to run as one too (#251). This creates a
// throwaway local user, lets it log on as a batch job, and runs the command
// through a scheduled task with limited rights. The task gets this process's
// environment, with its temporary, profile and npm cache directories moved into
// a work directory the user owns.
//
//   node scripts/ci-standard-user.mjs [--npm-global <package>] <command> [args...]
//
// --npm-global installs a package into an npm prefix inside the work
// directory and puts it first on the user's PATH. The runner's own global
// prefix lets every authenticated user write to it, and ACC rightly refuses a
// Codex CLI there; a person's prefix, %APPDATA%\npm, is private.
//
// Windows only; CI only. The runner is discarded after the job.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { npmCli } from "../packages/cli/src/managed-runtime/download.mjs";

const run = promisify(execFile);
const RESULT_TIMEOUT_MS = 25 * 60_000;
const START_TIMEOUT_MS = 90_000;

// PowerShell 7: Windows PowerShell 5.1 started from a pwsh step inherits a
// module path it cannot load ConvertTo-SecureString from.
const powershell = (script, env = process.env) => run("pwsh.exe",
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`],
  { env, maxBuffer: 16 << 20 });

// secedit writes and reads its configuration as UTF-16 with a byte order mark.
async function grantBatchLogon(sid, work) {
  const cfg = path.join(work, "rights.inf");
  await run("secedit.exe", ["/export", "/cfg", cfg, "/areas", "USER_RIGHTS"]);
  const text = (await readFile(cfg)).toString("utf16le").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(line => /^SeBatchLogonRight\s*=/.test(line));
  if (index >= 0) lines[index] = `${lines[index]},*${sid}`;
  else lines.splice(lines.findIndex(line => line.trim() === "[Privilege Rights]") + 1, 0,
    `SeBatchLogonRight = *${sid}`);
  await writeFile(cfg, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join("\r\n"), "utf16le")]));
  await run("secedit.exe", ["/configure", "/db", path.join(work, "rights.sdb"), "/cfg", cfg,
    "/areas", "USER_RIGHTS"]);
}

const grant = (target, user, rights) => run("icacls.exe", [target, "/grant", `${user}:(OI)(CI)${rights}`, "/Q"]);

export async function runAsStandardUser(command, args, { cwd = process.cwd(), env = process.env,
  npmGlobal = null } = {}) {
  if (process.platform !== "win32") throw new Error("standard-user runs are for Windows CI only");
  if (!env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required");
  const user = `acc-ci-${randomBytes(3).toString("hex")}`;
  const password = `Acc-${randomBytes(18).toString("base64url")}9!`;
  const work = path.join(env.RUNNER_TEMP, "su");
  await rm(work, { recursive: true, force: true });
  await mkdir(work);
  // A person's profile is private. The runner's D:\ lets Users write to
  // everything below it, and ACC rightly refuses a Codex home anyone can
  // change, so the work directory drops that inheritance: SYSTEM and
  // Administrators here, the user below once it exists.
  await run("icacls.exe", [work, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F", "/Q"]);
  for (const name of ["temp", "profile", "local", "roaming", "npm-cache"]) {
    await mkdir(path.join(work, name), { recursive: true });
  }
  await powershell("New-LocalUser -Name $env:ACC_SU_NAME -Password (ConvertTo-SecureString $env:ACC_SU_PASSWORD"
    + " -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires | Out-Null",
  { ...env, ACC_SU_NAME: user, ACC_SU_PASSWORD: password });
  const task = `acc-ci-${user}`;
  try {
    const { stdout: sid } = await powershell("(New-Object System.Security.Principal.NTAccount($env:ACC_SU_NAME))"
      + ".Translate([System.Security.Principal.SecurityIdentifier]).Value", { ...env, ACC_SU_NAME: user });
    await grantBatchLogon(sid.trim(), work);
    await grant(work, user, "F");
    await grant(cwd, user, "RX");

    // Installed by this elevated process into the private work directory: the
    // files inherit its list, and their owner is Administrators.
    const prefix = path.join(work, "npm-global");
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "Path";
    if (npmGlobal) {
      await run(process.execPath, [await npmCli(env), "install", "--global", "--prefix", prefix, npmGlobal],
        { env: { ...env, npm_config_cache: path.join(work, "npm-cache") }, maxBuffer: 16 << 20 });
    }
    const job = {
      command, args, cwd,
      env: { ...env, ...(npmGlobal ? { [pathKey]: `${prefix}${path.delimiter}${env[pathKey] ?? ""}` } : {}),
        TEMP: path.join(work, "temp"), TMP: path.join(work, "temp"),
        USERPROFILE: path.join(work, "profile"), HOME: path.join(work, "profile"),
        LOCALAPPDATA: path.join(work, "local"), APPDATA: path.join(work, "roaming"),
        npm_config_cache: path.join(work, "npm-cache") },
      stdout: path.join(work, "stdout.log"), stderr: path.join(work, "stderr.log"),
      started: path.join(work, "started.json"), result: path.join(work, "result.json"),
    };
    const jobFile = path.join(work, "job.json");
    await writeFile(jobFile, JSON.stringify(job));
    const launcher = path.join(work, "run.cmd");
    await writeFile(launcher, `@"${process.execPath}" "${path.resolve(import.meta.dirname, "ci-standard-user.mjs")}"`
      + ` --child "${jobFile}" > "${path.join(work, "launcher.log")}" 2>&1\r\n`);

    await run("schtasks.exe", ["/Create", "/TN", task, "/TR", launcher, "/SC", "ONCE", "/ST", "23:59",
      "/RU", user, "/RP", password, "/RL", "LIMITED", "/F"]);
    await run("schtasks.exe", ["/Run", "/TN", task]);

    const startDeadline = Date.now() + START_TIMEOUT_MS;
    const resultDeadline = Date.now() + RESULT_TIMEOUT_MS;
    let started = false;
    for (;;) {
      const result = await readFile(job.result, "utf8").then(JSON.parse, () => null);
      if (result !== null) {
        process.stdout.write(await readFile(job.stdout).catch(() => ""));
        process.stderr.write(await readFile(job.stderr).catch(() => ""));
        if (result.spawnError) console.error(`standard user: ${result.spawnError}`);
        return Number.isInteger(result.exitCode) ? result.exitCode : 1;
      }
      started ||= await readFile(job.started, "utf8").then(() => true, () => false);
      if (!started && Date.now() > startDeadline) {
        const query = await run("schtasks.exe", ["/Query", "/TN", task, "/V", "/FO", "LIST"])
          .then(({ stdout }) => stdout, error => error.message);
        const launched = await readFile(path.join(work, "launcher.log"), "utf8").catch(() => "(no launcher log)");
        throw new Error(`the task did not start as ${user}\n${query}\n${launched}`);
      }
      if (Date.now() > resultDeadline) {
        // What the command printed so far, and what still runs as the user,
        // is the only evidence of where it stopped.
        process.stdout.write(await readFile(job.stdout).catch(() => "(no stdout)\n"));
        process.stderr.write(await readFile(job.stderr).catch(() => "(no stderr)\n"));
        const running = await powershell("Get-CimInstance Win32_Process | Where-Object {"
          + " (Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue).User -eq $env:ACC_SU_NAME }"
          + " | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)\" }",
        { ...env, ACC_SU_NAME: user }).then(({ stdout }) => stdout, error => error.message);
        throw new Error(`no result from the task as ${user}; its processes:\n${running}`);
      }
      await delay(1_000);
    }
  } finally {
    await run("schtasks.exe", ["/End", "/TN", task]).catch(() => {});
    await run("schtasks.exe", ["/Delete", "/TN", task, "/F"]).catch(() => {});
    await powershell("Remove-LocalUser -Name $env:ACC_SU_NAME", { ...env, ACC_SU_NAME: user }).catch(() => {});
  }
}

// Inside the scheduled task: run the job with its environment and record how
// it ended. The token check is the point of the whole run, so it is recorded.
async function child(jobFile) {
  const job = JSON.parse(await readFile(jobFile, "utf8"));
  const { stdout: elevated } = await powershell("([Security.Principal.WindowsPrincipal]"
    + "[Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
  await writeFile(job.started, JSON.stringify({ pid: process.pid, administrator: elevated.trim() }));
  if (elevated.trim() !== "False") {
    await writeFile(job.result, JSON.stringify({ exitCode: 1, spawnError: "the task runs with an elevated token" }));
    return;
  }
  const out = await open(job.stdout, "w");
  const err = await open(job.stderr, "w");
  const outcome = await new Promise(resolve => {
    const spawned = spawn(job.command, job.args, { cwd: job.cwd, env: job.env,
      stdio: ["ignore", out.fd, err.fd], windowsHide: true });
    spawned.once("error", error => resolve({ exitCode: 1, spawnError: error.message }));
    spawned.once("exit", (code, signal) => resolve({ exitCode: code, signal }));
  });
  await out.close();
  await err.close();
  await writeFile(job.result, JSON.stringify(outcome));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "--child") await child(process.argv[3]);
    else {
      const rest = process.argv.slice(2);
      const npmGlobal = rest[0] === "--npm-global" ? rest.splice(0, 2)[1] : null;
      const [command, ...args] = rest;
      if (!command || command.startsWith("--") || npmGlobal?.startsWith("--")) {
        throw new Error("usage: ci-standard-user.mjs [--npm-global <package>] <command> [args...]");
      }
      process.exitCode = await runAsStandardUser(command, args, { npmGlobal });
    }
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
