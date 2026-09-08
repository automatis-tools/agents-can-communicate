// Owned real-client environment and installed artifact. No vendor transcript or
// terminal output is persisted; the outer scenario layer records closed facts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile }
  from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildClientEnvironment, createPtyDriver, prepareOwnedTools, prerequisiteChecks,
  resolveExecutable, verifyInstalledCommands, verifyInstalledTarget }
  from "./codex-local-daemon-harness.mjs";

const execute = promisify(execFile);
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const shellLiteral = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export async function run(executable, args, options = {}) {
  try {
    const result = await execute(executable, args, { timeout: 120_000, maxBuffer: 4_000_000, ...options });
    return result.stdout;
  } catch (error) {
    throw Object.assign(new Error(`command failed: ${path.basename(executable)} (${error.code ?? "unknown"})`),
      { code: error.code, stage: args[0] });
  }
}

export async function until(label, read, { timeoutMs = 90_000, intervalMs = 300 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`deadline: ${label}`);
}

export async function createMachine({ tarball, codex, phase, output, prepareTools = prepareOwnedTools,
  resolveRoot = realpath }) {
  for (const value of [tarball, codex, output]) assert.ok(path.isAbsolute(value), "explicit absolute path required");
  assert.ok(["transport", "product"].includes(phase), "unknown phase");
  const [python, npm] = await Promise.all([resolveExecutable("python3"), resolveExecutable("npm")]);
  try { await prerequisiteChecks({ tarball, codex, python }); }
  catch (error) {
    error.harness = { phase, version: null, packageSha256: null, scenarios: [], cleanup: { attempted: true, outcome: "passed",
      ownedProcesses: "stopped", temporaryState: "removed" } };
    throw error;
  }
  if (npm === null) {
    const error = new Error("prerequisite: npm unavailable");
    error.harness = { phase, version: null, packageSha256: null, scenarios: [], cleanup: {
      attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" } };
    throw error;
  }
  const rawRoot = await mkdtemp(path.join(os.tmpdir().startsWith("/var/") ? "/tmp" : os.tmpdir(), "cx-e2e-"));
  const h = { root: rawRoot, codex, phase, output, tarball, version: null, packageSha256: null,
    roles: {}, daemonStarted: false, cleanupDone: false };
  h.cleanup = async () => {
    if (h.cleanupResult) return h.cleanupResult;
    let processes = true;
    let state = true;
    await h.pty?.close().catch(() => { processes = false; });
    for (const role of Object.values(h.roles)) {
      if (!Number.isInteger(role.pid)) continue;
      await until(`owned client ${role.role} exit`, () => {
        try { process.kill(role.pid, 0); return false; } catch { return true; }
      }, { timeoutMs: 2_000 }).catch(() => { processes = false; });
    }
    if (h.daemonStarted) {
      await run(codex, ["app-server", "daemon", "stop"],
        { cwd: h.A, env: h.env, timeout: 20_000 }).catch(() => null);
      // Some vendor versions return an error after already stopping. Verify
      // the owned process rather than treating the command status as liveness.
      const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (const pid of h.daemonPids ?? []) {
        if (!alive(pid)) continue;
        const cwd = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
          .then(text => text.split("\n").find(line => line.startsWith("n"))?.slice(1), () => null);
        if (cwd !== h.A) { processes = false; continue; }
        process.kill(pid, "SIGTERM");
        await until("owned daemon exit", () => !alive(pid), { timeoutMs: 5_000 }).catch(() => {
          if (alive(pid)) process.kill(pid, "SIGKILL");
        });
        await until("owned daemon reaped", () => !alive(pid), { timeoutMs: 5_000 })
          .catch(() => { processes = false; });
      }
    }
    await rm(h.root, { recursive: true, force: true }).catch(() => { state = false; });
    h.cleanupDone = processes && state;
    h.cleanupResult = { attempted: true, outcome: h.cleanupDone ? "passed" : "failed",
      ownedProcesses: processes ? "stopped" : "failed", temporaryState: state ? "removed" : "failed" };
    return h.cleanupResult;
  };
  try {
    const root = await resolveRoot(rawRoot);
    h.root = root;
    h.home = path.join(root, "user"); h.codexHome = path.join(root, "cx");
    h.dataHome = path.join(root, "data"); h.prefix = path.join(root, "prefix with spaces");
    h.toolDir = path.join(root, "owned-tools");
    h.A = path.join(root, "A"); h.B = path.join(root, "B receiver with spaces"); h.C = path.join(root, "C");
    h.packageSha256 = sha256(await readFile(tarball));
    await prepareTools({ toolDir: h.toolDir, npm, python });
    h.env = buildClientEnvironment({ inherited: process.env, codex, toolDir: h.toolDir,
      home: h.home, codexHome: h.codexHome });
    h.accEnv = { ...h.env, ACC_DATA_HOME: h.dataHome, ACC_UPDATE_CHECK: "0", ACC_NO_UPDATE_CHECK: "1" };
    for (const dir of [h.home, h.codexHome, h.dataHome, h.A, h.B, h.C, output]) await mkdir(dir, { recursive: true });
    const auth = path.join(os.homedir(), ".codex", "auth.json");
    await stat(auth); // Existence only; credentials are never read into the harness.
    await symlink(auth, path.join(h.codexHome, "auth.json"));
    const standalone = path.join(h.codexHome, "packages", "standalone");
    await mkdir(standalone, { recursive: true });
    await symlink(path.dirname(path.dirname(codex)), path.join(standalone, "current"));
    await writeFile(path.join(h.codexHome, "config.toml"),
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n');
    const version = await run(codex, ["--version"], { cwd: h.A, env: h.env });
    h.version = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(version.trim())?.[1];
    assert.ok(h.version, "exact stable vendor version required");
    await run(path.join(h.toolDir, "npm"), ["install", "--prefix", h.prefix, "--no-audit", "--no-fund", tarball],
      { env: { ...h.env, npm_config_cache: path.join(root, "npm-cache") } });
    h.packageRoot = await verifyInstalledTarget(path.join(h.prefix, "node_modules",
      "agents-can-communicate"), { packageRoot: h.prefix, label: "ACC package" });
    h.cli = await verifyInstalledTarget(path.join(h.packageRoot, "bin", "acc.mjs"),
      { packageRoot: h.packageRoot, label: "CLI" });
    h.module = async relative => {
      const target = await verifyInstalledTarget(path.join(h.packageRoot, "node_modules",
        "@agents-can-communicate", relative), { packageRoot: h.packageRoot, label: "ACC module" });
      return import(pathToFileURL(target));
    };
    h.acc = async (args, { cwd = h.B, env = h.accEnv } = {}) => JSON.parse(
      await run(process.execPath, [h.cli, ...args, "--json"], { cwd, env }));
    h.install = async policy => {
      const result = await h.acc(["install", "--adapter", "codex", "--delivery", policy]);
      const report = result.data ?? result;
      assert.deepEqual(report.failed, [], "installed artifact must apply without failures");
      assert.equal(report.operations?.some(operation => operation.adapterId === "codex" && operation.applied), true);
      return report;
    };
    await run(codex, ["app-server", "daemon", "start"], { cwd: h.A, env: h.env });
    h.daemonStarted = true;
    const socket = path.join(h.codexHome, "app-server-control", "app-server-control.sock");
    assert.ok(Buffer.byteLength(socket) < 104);
    await until("owned daemon socket", () => stat(socket).then(info => info.isSocket(), () => false));
    h.daemonPids = (await run("/usr/sbin/lsof", ["-t", socket])).trim().split(/\s+/).map(Number);
    assert.ok(h.daemonPids.length > 0 && h.daemonPids.every(pid => Number.isInteger(pid) && pid > 1));
    h.daemonAt = new Date().toISOString();
    await h.install(phase === "product" ? "actionable" : "off");
    h.installedAt = new Date().toISOString();
    h.hookShim = path.join(h.home, ".agents", "acc-local", "plugins",
      "agents-can-communicate", "acc-hook.sh");
    const cache = path.join(h.codexHome, "plugins", "cache", "acc-local", "agents-can-communicate");
    const versions = await readdir(cache);
    assert.equal(versions.length, 1, "installed Codex plugin cache has one exact version");
    const cached = path.join(cache, versions[0]);
    h.installedSkill = path.join(cached, "skills", "acc", "SKILL.md");
    h.installedCommands = await verifyInstalledCommands({ hook: h.hookShim,
      skill: h.installedSkill, packageRoot: h.packageRoot, dataHome: h.dataHome,
      hookManifest: path.join(cached, "hooks.json") });
    h.pty = createPtyDriver({ python });
    h.hookFile = path.join(root, "hooks.jsonl");
    h.hooks = async () => (await readFile(h.hookFile, "utf8").catch(() => ""))
      .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return h;
  } catch (error) {
    const cleanup = await h.cleanup().catch(() => ({ attempted: true, outcome: "failed",
      ownedProcesses: "failed", temporaryState: "failed" }));
    error.harness = { phase, version: h.version, packageSha256: h.packageSha256,
      scenarios: h.scenarios ?? [], cleanup };
    throw error;
  }
}

export async function observeHooks(h) {
  const generated = path.join(h.home, ".agents", "acc-local", "plugins", "agents-can-communicate", "acc-hook.sh");
  const original = path.join(h.root, "original-hook.sh");
  await copyFile(generated, original);
  const observer = path.join(h.root, "observer.mjs");
  await writeFile(observer, `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const rows = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout.split('\\n');
let pid = process.ppid; const parents = [];
for (let i = 0; i < 12 && pid > 1; i++) {
  const row = rows.map(line => line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/)).find(row => row && +row[1] === pid);
  if (!row) break; parents.push({ pid: +row[1], ppid: +row[2], name: row[3].split('/').at(-1) }); pid = +row[2];
}
appendFileSync(${JSON.stringify(h.hookFile)}, JSON.stringify({ at: new Date().toISOString(),
  event: payload.hook_event_name, threadId: payload.session_id, cwd: payload.cwd,
  processCwd: process.cwd(), parents }) + '\\n');
const child = spawnSync('/bin/sh', [${JSON.stringify(original)}, ...process.argv.slice(2)], { input, encoding: 'utf8' });
process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? ''); process.exitCode = child.status ?? 0;
`);
  await writeFile(generated, `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(observer)} "$@"\n`);
  await chmod(generated, 0o700);
  h.generatedHook = generated; h.originalHook = original;
}

export async function observeBindingDiagnostic(h) {
  // Diagnostic-only instrumentation, never a passing product receipt. Records
  // the runner's existing closed outcome without changing its decisions.
  const file = path.join(h.packageRoot, "bin", "acc-hook.mjs");
  h.bindingDiagnostics = path.join(h.root, "binding-diagnostics.jsonl");
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace('import { realpathSync }', 'import { appendFileSync, realpathSync }')
    .replace("  const completed = await completeHookOutput(result);", `
  appendFileSync(${JSON.stringify(h.bindingDiagnostics)}, JSON.stringify({
    event: payload?.hook_event_name ?? null, at: new Date().toISOString(),
    binding: result.nativeBinding ?? null, timedOut: result.timedOut === true,
    homeMatches: process.env.CODEX_HOME === ${JSON.stringify(h.codexHome)},
  }) + "\\n");
  const completed = await completeHookOutput(result);`));
  const nativePath = path.join(h.packageRoot, "node_modules/@agents-can-communicate/adapter-codex/src/native-delivery.mjs");
  const native = await readFile(nativePath, "utf8");
  const log = value => `appendFileSync(${JSON.stringify(h.bindingDiagnostics)}, JSON.stringify(${value}) + "\\n");`;
  await writeFile(nativePath, 'import { appendFileSync } from "node:fs";\n' + native
    .replace("  const rejected = reason => closed(clientVersion, reason);", `  const rejected = reason => {
      ${log('{ stage: "bind-rejected", reason }')} return closed(clientVersion, reason); };`)
    .replace("  if (!probe.supported) return probe.reasonCode", `  ${log('{ stage: "queue-probe", supported: probe.supported, reason: probe.reasonCode, serverVersion: probe.serverVersion }')}
  if (!probe.supported) return probe.reasonCode`)
    .replace("  return located.found ? null", `  ${log('{ stage: "locate", found: located.found, reason: located.reasonCode ?? null, status: located.status ?? null }')}
  return located.found ? null`));
}
