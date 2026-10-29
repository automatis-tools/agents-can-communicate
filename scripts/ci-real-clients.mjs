// CI-only acquisition, fixed compatibility commands and their evidence stay in
// one lifecycle. This is compatibility against loopback stubs, not certification.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { npmCli } from "../packages/cli/src/managed-runtime/download.mjs";

const pins = { claude: "2.1.312", codex: "0.165.0" };
const now = () => new Date().toISOString();
const elapsed = started => Math.max(0, Date.now() - Date.parse(started));

function testSummary(output) {
  const match = /^# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)\r?\n# duration_ms (\d+(?:\.\d+)?)\s*$/.exec(
    output.slice(output.lastIndexOf("\n# tests ") + 1));
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isFinite) || !values.slice(0, 6).every(Number.isSafeInteger)) return null;
  return Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped", "todo", "durationMs"]
    .map((key, index) => [key, values[index]]));
}

/** Only process fixtures replace npm discovery/launch; the public CLI has no overrides. */
export async function runRealClients({ cwd, env, evidenceDir, platform = process.platform }, dependencies = {}) {
  const launch = dependencies.spawn ?? spawn;
  const resolveNpm = dependencies.npmCli ?? npmCli;
  const report = {
    schemaVersion: 1, kind: "real-client-compatibility", status: "running", failure: null,
    policy: null, requestedClients: { claude: null, codex: null },
    observedClients: Object.fromEntries(["claude", "codex"].map(client => [client,
      { version: null, status: "not-run", reason: "acquisition has not completed", phase: `${client}-version` }])),
    context: {
      eventName: env.GITHUB_EVENT_NAME ?? null, ref: env.GITHUB_REF ?? null,
      repository: env.GITHUB_REPOSITORY ?? null, workflow: env.GITHUB_WORKFLOW ?? null,
      job: env.GITHUB_JOB ?? null, runId: env.GITHUB_RUN_ID ?? null, runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
      githubSha: env.GITHUB_SHA ?? null, checkoutSha: null, pullRequestHeadSha: null,
      platform, arch: process.arch, osRelease: os.release(), nodeVersion: process.version,
      nodeExecutable: process.execPath, npmVersion: null,
      runnerOs: env.RUNNER_OS ?? null, runnerArch: env.RUNNER_ARCH ?? null,
      runnerImage: env.ImageOS ?? null, runnerImageVersion: env.ImageVersion ?? null,
      unavailable: { checkoutSha: "git query not completed", npmVersion: "npm query not completed",
        pullRequestHeadSha: "not independently observed", runnerOs: env.RUNNER_OS ? null : "not supplied",
        runnerArch: env.RUNNER_ARCH ? null : "not supplied", runnerImage: env.ImageOS ? null : "not supplied",
        runnerImageVersion: env.ImageVersion ? null : "not supplied" },
    },
    conditions: { packedAcc: true, privateClientHomes: true, modelEndpoint: "loopback-stub",
      externalModelProvider: false, certification: false },
    startedAt: now(), finishedAt: null, durationMs: null, phases: [],
  };
  function phase(id, executable, args) {
    const value = { id, executable, args, cwd, status: "not-run", reason: "blocked by incomplete prerequisites",
      startedAt: null, finishedAt: null, durationMs: null, exitCode: null, signal: null, spawnError: null, outputError: null,
      stdoutFile: `${id}.stdout.log`, stderrFile: `${id}.stderr.log`, tests: null };
    report.phases.push(value);
    return value;
  }
  const resolution = phase("npm-resolution", null, []);
  const npmVersion = phase("npm-version", process.execPath, []);
  const checkout = phase("checkout", "git", ["rev-parse", "HEAD"]);
  const install = phase("install", process.execPath, []);
  const versions = Object.fromEntries(["claude", "codex"].map(client => [client,
    phase(`${client}-version`, platform === "win32" ? "pwsh" : client, platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference = 'Stop'; ${client} --version; exit $LASTEXITCODE`] : ["--version"])]));
  const hooks = phase("hooks", process.execPath,
    ["--test", "--test-reporter=tap", "tests/acceptance/real-clients-stub.test.mjs"]);
  const approval = phase("command-approval", process.execPath,
    ["--test", "--test-reporter=tap", "tests/acceptance/codex-command-approval.test.mjs"]);
  if (platform === "win32") Object.assign(approval, {
    status: "not-applicable", reason: "POSIX-only command approval is unsupported on Windows",
  });
  const terminal = phase("pywinpty", "python", ["-m", "pip", "install", "--quiet", "pywinpty"]);
  if (platform !== "win32") Object.assign(terminal, { status: "not-applicable", reason: "POSIX uses Python pty" });
  const interactive = phase("interactive", process.execPath,
    ["--test", "--test-reporter=tap", "tests/acceptance/real-claude-live-stub.test.mjs"]);
  await mkdir(evidenceDir, { recursive: true });
  const checkpoint = async () => {
    const file = path.join(evidenceDir, "compatibility.json");
    await writeFile(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
  };
  const fail = (p, reason) => {
    p.status = "failed"; p.reason = reason;
    report.failure ??= { phase: p.id, reason };
  };
  const finish = async () => {
    report.status = report.failure ? "failed" : "passed";
    report.finishedAt = now(); report.durationMs = elapsed(report.startedAt);
    for (const p of report.phases) if (p.status === "not-run") p.reason = `blocked: ${report.failure?.phase ?? "incomplete prerequisites"}`;
    for (const observation of Object.values(report.observedClients)) {
      if (observation.status === "not-run") observation.reason = `blocked: ${report.failure?.phase ?? "acquisition"}`;
    }
    await checkpoint();
    return report.failure ? 1 : 0;
  };
  async function execute(p, childEnv = env) {
    p.status = "running"; p.reason = null; p.startedAt = now();
    await checkpoint();
    console.log(`compatibility: ${p.id}`);
    const stdout = createWriteStream(path.join(evidenceDir, p.stdoutFile));
    const stderr = createWriteStream(path.join(evidenceDir, p.stderrFile));
    let child, closed;
    const streams = [];
    try {
      child = launch(p.executable, p.args, { cwd, env: childEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      closed = new Promise(resolve => {
        child.on("error", error => { p.spawnError = { code: error.code ?? null, message: error.message }; });
        child.on("close", (code, signal) => { p.exitCode = code; p.signal = signal; resolve(); });
      });
      child.stdin.on("error", () => {}); // A failed launch can close stdin before end().
      child.stdin.end();
      child.stdout.on("data", bytes => process.stdout.write(bytes));
      child.stderr.on("data", bytes => process.stderr.write(bytes));
      streams.push(pipeline(child.stdout, stdout), pipeline(child.stderr, stderr));
      await Promise.all([closed, ...streams]);
      if (p.spawnError || p.exitCode !== 0 || p.signal) fail(p, p.spawnError?.message ?? `exit ${p.exitCode}, signal ${p.signal}`);
      else p.status = "passed";
    } catch (error) {
      if (child && !p.spawnError) p.outputError = { code: error.code ?? null, message: error.message };
      else p.spawnError ??= { code: error.code ?? null, message: error.message };
      stdout.destroy(); stderr.destroy();
      // Reap this exact child before recording its result or starting a phase.
      // Windows may report termination as an exit code; preserve close's facts.
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.allSettled([...streams, ...(closed ? [closed] : [])]);
      fail(p, p.outputError ? `output capture failed: ${error.message}` : error.message);
    }
    p.finishedAt = now(); p.durationMs = elapsed(p.startedAt);
    await checkpoint();
    return p.outputError ? "" : readFile(path.join(evidenceDir, p.stdoutFile), "utf8");
  }
  await checkpoint();
  const required = ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW", "GITHUB_JOB", "GITHUB_SHA", "GITHUB_REF"];
  if (!/^(?:true|1)$/i.test(env.CI ?? "") || !env.RUNNER_TEMP || required.some(key => !env[key])
    || !/^\d+$/.test(env.GITHUB_RUN_ID) || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT)
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)) {
    fail(resolution, "required CI execution context is missing or invalid"); return finish();
  }
  if (env.GITHUB_EVENT_NAME === "pull_request") report.policy = "pinned-pr";
  else if ((env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main")
    || (env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_WORKFLOW === "Client compatibility (latest)")) report.policy = "latest";
  else { fail(resolution, "unsupported CI event or workflow"); return finish(); }
  report.requestedClients = report.policy === "pinned-pr" ? { ...pins } : { claude: "latest", codex: "latest" };
  resolution.status = "running"; resolution.startedAt = now(); resolution.reason = null;
  await checkpoint();
  try {
    const npm = await resolveNpm(env);
    npmVersion.args = [npm, "--version"];
    install.args = [npm, "install", "--global", ...["@anthropic-ai/claude-code", "@openai/codex"]
      .map((name, index) => report.policy === "pinned-pr" ? `${name}@${[pins.claude, pins.codex][index]}` : name)];
    resolution.status = "passed";
  } catch (error) { fail(resolution, error.message); }
  resolution.finishedAt = now(); resolution.durationMs = elapsed(resolution.startedAt);
  await checkpoint();
  if (resolution.status === "failed") return finish();
  const npmOutput = await execute(npmVersion);
  if (npmVersion.outputError) return finish();
  if (npmVersion.status === "passed" && /^\d+\.\d+\.\d+\r?\n?$/.test(npmOutput)) {
    report.context.npmVersion = npmOutput.trim(); report.context.unavailable.npmVersion = null;
  } else { fail(npmVersion, "npm version unavailable or malformed"); report.context.unavailable.npmVersion = npmVersion.reason; }
  const gitEnv = { ...env };
  delete gitEnv.GIT_DIR; delete gitEnv.GIT_WORK_TREE;
  const gitOutput = await execute(checkout, gitEnv);
  if (checkout.outputError) return finish();
  if (checkout.status === "passed" && /^[a-f0-9]{40}\r?\n?$/.test(gitOutput)) {
    report.context.checkoutSha = gitOutput.trim(); report.context.unavailable.checkoutSha = null;
  } else { fail(checkout, "checkout identity unavailable or malformed"); report.context.unavailable.checkoutSha = checkout.reason; }
  await execute(install);
  if (install.status !== "passed") return finish();
  for (const client of ["claude", "codex"]) {
    const p = versions[client];
    const output = await execute(p);
    if (p.outputError) return finish();
    const pattern = client === "claude" ? /^(\d+\.\d+\.\d+) \(Claude Code\)\r?\n?$/ : /^codex-cli (\d+\.\d+\.\d+)\r?\n?$/;
    const version = p.status === "passed" ? pattern.exec(output)?.[1] ?? null : null;
    if (!version || (report.policy === "pinned-pr" && version !== pins[client])) {
      fail(p, !version ? "actual client version unavailable or malformed" : `expected ${pins[client]}, observed ${version}`);
    }
    report.observedClients[client] = { version, status: p.status, reason: p.reason, phase: p.id };
    await checkpoint();
  }
  if (report.failure) return finish();
  const testEnv = { ...env, ACC_REAL_CLIENTS: "1", GIT_DIR: "", GIT_WORK_TREE: "" };
  async function behavior(p) {
    const output = await execute(p, testEnv);
    p.tests = testSummary(output);
    const s = p.tests;
    if (!s || s.tests <= 0 || s.pass <= 0 || s.tests !== s.pass
      || [s.fail, s.cancelled, s.skipped, s.todo].some(value => value !== 0)) fail(p, "missing, incomplete or unsuccessful TAP summary");
    // Node 24 can wrap an empty test file as one passing file in its summary.
    if (/^1\.\.0(?:\s*#.*)?\r?$/m.test(output)) fail(p, "empty TAP test plan");
    await checkpoint();
  }
  await behavior(hooks);
  if (report.failure) return finish();
  if (platform !== "win32") {
    await behavior(approval);
    if (report.failure) return finish();
  }
  if (platform === "win32") {
    await execute(terminal);
    if (report.failure) return finish();
  }
  await behavior(interactive);
  return finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("CI real-client driver does not accept arguments");
    if (!process.env.RUNNER_TEMP) throw new Error("CI RUNNER_TEMP is required; local global installation is forbidden");
    process.exitCode = await runRealClients({ cwd: process.cwd(), env: process.env,
      evidenceDir: path.join(process.env.RUNNER_TEMP, "acc-client-compatibility") });
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
