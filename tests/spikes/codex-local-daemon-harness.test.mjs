import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { trust } from "../../scripts/e2e/codex-local-daemon-actions.mjs";
import { buildClientEnvironment, createPtyDriver, prerequisiteChecks,
  verifyInstalledCommands, verifyInstalledTarget }
  from "../../scripts/e2e/codex-local-daemon-harness.mjs";
import { migrationEnvironments }
  from "../../scripts/e2e/codex-local-daemon-migration.mjs";
import { createMachine }
  from "../../scripts/e2e/codex-local-daemon-machine.mjs";
import { scenario }
  from "../../scripts/e2e/codex-local-daemon-observations.mjs";
import { finalizeHarnessRun }
  from "../../scripts/e2e/codex-local-daemon-runner.mjs";

const execute = promisify(execFile);
const python = async () => (await execute("/usr/bin/env", ["python3", "-c",
  "import os; print(os.path.realpath(os.sys.executable))"])).stdout.trim();
const fixture = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("client environment strips inherited agent state and exposes only isolated tools", async t => {
  const root = await fixture(t);
  const codex = path.join(root, "codex-bin", "codex");
  const toolDir = path.join(root, "owned-tools");
  const env = buildClientEnvironment({ inherited: {
    PATH: "/host/node/bin:/usr/local/bin", ACC_DATA_HOME: "/host/acc",
    ACC_NATIVE_DELIVERY_POLICY: "actionable", CODEX_HOME: "/host/codex",
    NODE_OPTIONS: "--require=/host/repo/hook.mjs", NODE_PATH: "/host/node_modules",
    LANG: "en_CA.UTF-8",
  }, codex, toolDir, home: path.join(root, "home"), codexHome: path.join(root, "cx") });

  assert.equal(env.PATH,
    `${path.dirname(codex)}:${toolDir}:/usr/bin:/bin:/usr/sbin:/sbin`);
  assert.equal(env.LANG, "en_CA.UTF-8");
  assert.equal(env.ACC_DATA_HOME, undefined);
  assert.equal(env.ACC_NATIVE_DELIVERY_POLICY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.CODEX_HOME, path.join(root, "cx"));
});

test("prerequisites name a missing supplied Codex binary and missing Python PTY support", async t => {
  const root = await fixture(t);
  const tarball = path.join(root, "candidate.tgz");
  const codex = path.join(root, "codex");
  await writeFile(tarball, "fixture");
  await writeFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(codex, 0o755);

  await assert.rejects(prerequisiteChecks({ tarball, codex: path.join(root, "missing-codex"),
    python: await python() }), /prerequisite: supplied Codex binary unavailable/);
  await assert.rejects(prerequisiteChecks({ tarball, codex,
    python: path.join(root, "missing-python") }), /prerequisite: Python PTY support unavailable/);
});

test("installed command verification accepts the isolated package and rejects repository targets", async t => {
  const root = await fixture(t);
  const prefix = path.join(root, "prefix");
  const packageRoot = path.join(prefix, "node_modules", "agents-can-communicate");
  const bin = path.join(packageRoot, "bin");
  await mkdir(bin, { recursive: true });
  const cli = path.join(bin, "acc.mjs");
  const runner = path.join(bin, "acc-hook.mjs");
  await writeFile(cli, ""); await writeFile(runner, "");
  assert.equal(await verifyInstalledTarget(packageRoot,
    { packageRoot: prefix, label: "ACC package" }), await realpath(packageRoot));
  assert.equal(await verifyInstalledTarget(cli, { packageRoot, label: "CLI" }), await realpath(cli));
  await assert.rejects(verifyInstalledTarget(import.meta.filename,
    { packageRoot, label: "module" }), /module resolves outside isolated npm prefix/);

  const hook = path.join(root, "acc-hook.sh");
  const skill = path.join(root, "SKILL.md");
  await writeFile(hook, `ACC_NODE="${process.execPath}"\nACC_RUNNER="${runner}"\n`);
  await writeFile(skill, `Run:\n\`\`\`bash\nACC_DATA_HOME="${root}/data" "${process.execPath}" "${cli}" inbox --json\n\`\`\`\n`);
  const verified = await verifyInstalledCommands({ hook, skill, packageRoot });
  assert.equal(verified.hookRunner, await realpath(runner));
  assert.equal(verified.skillCli, await realpath(cli));
  assert.match(verified.skillCommand, /ACC_DATA_HOME=.*acc\.mjs"$/);
  const outside = path.join(root, "repository", "acc.mjs");
  await mkdir(path.dirname(outside), { recursive: true });
  await writeFile(outside, "");
  await writeFile(skill, `\`\`\`bash\n"${process.execPath}" "${outside}" inbox\n\`\`\`\n`);
  await assert.rejects(verifyInstalledCommands({ hook, skill, packageRoot }),
    /skill CLI resolves outside isolated npm prefix/);
});

test("PTY shutdown acknowledges cleanup, exits the driver, and reaps its owned client", async t => {
  const pty = createPtyDriver({ python: await python() });
  t.after(() => pty.close().catch(() => null));
  const { pid } = await pty.request({ action: "launch", role: "child",
    argv: ["/bin/sh", "-c", "sleep 30"], cwd: os.tmpdir(), env: process.env });
  assert.equal(alive(pid), true);
  assert.deepEqual(await pty.close(), { shutdown: true, exited: true });
  assert.equal(alive(pid), false);
});

test("cwd selection is recognized and trust chooses the existing session directory", async t => {
  const root = await fixture(t);
  const marker = path.join(root, "choice.txt");
  const program = [
    "import pathlib,sys,time",
    "print('Choose working directory to continue')",
    "print('1. Use session directory (/session)')",
    "print('2. Use current directory (/current)')",
    "print('Press Enter to continue', flush=True)",
    `pathlib.Path(${JSON.stringify(marker)}).write_text(sys.stdin.readline())`,
    "print('gpt-test context left ›', flush=True)",
    "time.sleep(30)",
  ].join(";");
  const pty = createPtyDriver({ python: await python() });
  t.after(() => pty.close().catch(() => null));
  await pty.request({ action: "launch", role: "receiver",
    argv: [await python(), "-c", program], cwd: root, env: process.env });
  const h = { pty, roles: { receiver: { hookTrusted: false } }, debugStatus: false };
  await new Promise(resolve => setTimeout(resolve, 150));
  const status = await trust(h, "receiver");
  assert.equal(status.cwdSelection, true);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await readFile(marker, "utf8")).trim(), "1");
});

test("unexpected argument text is a launch error only when the vendor exits", async t => {
  const py = await python();
  const pty = createPtyDriver({ python: py });
  t.after(() => pty.close().catch(() => null));
  const h = { pty, roles: { active: {}, exited: {} }, debugStatus: false };
  await pty.request({ action: "launch", role: "active",
    argv: [py, "-c", "import time; print('unexpected argument', flush=True); time.sleep(30)"],
    cwd: os.tmpdir(), env: process.env });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await trust(h, "active")).invalidArgs, true);
  await pty.request({ action: "launch", role: "exited",
    argv: [py, "-c", "import sys; print('unexpected argument', flush=True); sys.exit(2)"],
    cwd: os.tmpdir(), env: process.env });
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(trust(h, "exited"), /vendor rejected launch arguments/);
});

test("migration keeps ACC variables out of the daemon and in installed commands", () => {
  const result = migrationEnvironments({ PATH: "/isolated", ACC_DATA_HOME: "/leak",
    ACC_NATIVE_DELIVERY_POLICY: "actionable", NODE_OPTIONS: "--inspect" }, {
    home: "/home", codexHome: "/codex", dataHome: "/data",
  });
  assert.equal(result.daemonEnv.CODEX_HOME, "/codex");
  assert.equal(result.daemonEnv.ACC_DATA_HOME, undefined);
  assert.equal(result.daemonEnv.ACC_NATIVE_DELIVERY_POLICY, undefined);
  assert.equal(result.commandEnv.ACC_DATA_HOME, "/data");
  assert.equal(result.commandEnv.ACC_UPDATE_CHECK, "0");
});

test("schema validation failures still write closed incomplete evidence after cleanup", async t => {
  const root = await fixture(t);
  const output = path.join(root, "output");
  const cleanup = { attempted: true, outcome: "passed",
    ownedProcesses: "stopped", temporaryState: "removed" };
  const h = { phase: "product", version: "0.153.4", packageSha256: "a".repeat(64),
    scenarios: [], cleanup: async () => cleanup };
  const result = await finalizeHarnessRun({ h, output, startedAt: "2026-09-08T00:00:00.000Z",
    failed: false, validate: () => { throw new Error("schema mutation"); } });
  assert.equal(result.complete, false);
  assert.equal(result.failure.stage, "evidence-validation");
  assert.equal(result.failure.error, "schema mutation");
  assert.deepEqual(result.cleanup, cleanup);
  assert.equal(JSON.parse(await readFile(path.join(output, "incomplete-evidence.json"), "utf8")).complete, false);
});

test("setup prerequisite failures still write closed incomplete evidence", async t => {
  const root = await fixture(t);
  const output = path.join(root, "output");
  const cleanup = { attempted: true, outcome: "passed",
    ownedProcesses: "stopped", temporaryState: "removed" };
  const result = await finalizeHarnessRun({ setupFailure: { phase: "transport", scenarios: [], cleanup },
    output, startedAt: "2026-09-08T00:00:00.000Z", failed: true,
    failure: { stage: "setup-or-scenario", error: "prerequisite: supplied Codex binary unavailable" },
    validate: () => { throw new Error("must not validate incomplete setup"); } });
  assert.equal(result.complete, false);
  assert.deepEqual(result.cleanup, cleanup);
  assert.equal(result.failure.stage, "setup-or-scenario");
  assert.equal(JSON.parse(await readFile(path.join(output, "incomplete-evidence.json"), "utf8")).complete, false);
});

test("owned-tool setup failures remove the allocated root and close the receipt", async t => {
  const root = await fixture(t);
  const tarball = path.join(root, "candidate.tgz");
  const output = path.join(root, "output");
  await writeFile(tarball, "fixture");
  let allocatedRoot;
  t.after(() => allocatedRoot && rm(allocatedRoot, { recursive: true, force: true }));
  const error = await createMachine({ tarball, codex: "/bin/sh", phase: "transport", output,
    prepareTools: async ({ toolDir }) => {
      allocatedRoot = path.dirname(toolDir);
      throw new Error("controlled owned-tool setup failure");
    } }).then(() => assert.fail("owned tool setup should fail"), value => value);
  assert.match(error.message, /controlled owned-tool setup failure/);
  assert.equal(error.harness.version, null);
  assert.match(error.harness.packageSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(error.harness.cleanup, { attempted: true, outcome: "passed",
    ownedProcesses: "stopped", temporaryState: "removed" });
  await assert.rejects(access(allocatedRoot), item => item?.code === "ENOENT");
  const result = await finalizeHarnessRun({ setupFailure: error.harness, output,
    startedAt: "2026-09-08T00:00:00.000Z", failed: true,
    failure: { stage: "setup-or-scenario", error: error.message }, validate: () => {} });
  assert.equal(result.complete, false);
  assert.deepEqual(result.cleanup, error.harness.cleanup);
  assert.equal(JSON.parse(await readFile(path.join(output, "incomplete-evidence.json"), "utf8")).complete, false);
});

test("scenario equality emits closed mismatch reasons and retains named assertions", () => {
  const h = { phase: "product", version: "0.153.4", packageSha256: "a".repeat(64), roles: {}, scenarios: [] };
  const unnamed = scenario(h, "P08");
  assert.throws(() => unnamed.equal("actual-sentinel", "expected-sentinel"), error =>
    error?.message === "scenario P08 assertion 1 failed: deep equality mismatch"
      && !error.message.includes("actual-sentinel") && !error.message.includes("expected-sentinel"));
  const named = scenario(h, "T01");
  assert.throws(() => named.equal("actual-sentinel", "expected-sentinel", "same Codex thread must reject A cwd"), error =>
    error?.message === "scenario T01 assertion 1 failed: same Codex thread must reject A cwd"
      && !error.message.includes("actual-sentinel") && !error.message.includes("expected-sentinel"));
});
