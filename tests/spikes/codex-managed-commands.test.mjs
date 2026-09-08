import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { stageOwnGeneration } from "../../packages/cli/src/managed-runtime/generation.mjs";
import { writeLaunchers } from "../../packages/cli/src/managed-runtime/launchers.mjs";
import { buildClientEnvironment, verifyInstalledCommands } from "../../scripts/e2e/codex-local-daemon-harness.mjs";

test("native harness verifies managed launchers and their exact installed generation", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "acc-managed-commands-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  const dataHome = path.join(root, "data");
  const managerRoot = path.join(dataHome, "acc", "runtime");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  const manifest = { name: "agents-can-communicate", version: "0.4.0", files: ["bin"], bundleDependencies: [] };
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageRoot, "bin", "acc.mjs"), "// installed CLI\n");
  await writeFile(path.join(packageRoot, "bin", "acc-hook.mjs"), "// installed hook\n");
  // The generated immutable modules must also match this installed artifact.
  const moduleRoot = path.join(packageRoot, "node_modules", "@agents-can-communicate", "cli", "src", "managed-runtime");
  await mkdir(moduleRoot, { recursive: true });
  for (const name of ["entry", "state", "mutex", "leases", "schedule", "policy"]) {
    await cp(new URL(`../../packages/cli/src/managed-runtime/${name}.mjs`, import.meta.url),
      path.join(moduleRoot, `${name}.mjs`));
  }
  const active = await stageOwnGeneration({ packageRoot, managerRoot });
  const commands = await writeLaunchers(managerRoot, active.root);
  await writeFile(path.join(managerRoot, "control.json"), JSON.stringify({ phase: "ready", active }));
  const hook = path.join(root, "acc-hook.sh"), skill = path.join(root, "SKILL.md");
  await writeFile(hook, `ACC_RUNNER="${commands.runner}"\n`);
  await writeFile(skill, `"${process.execPath}" "${commands.cli}" inbox\n`);
  const input = { hook, skill, packageRoot, dataHome };
  const verified = await verifyInstalledCommands(input);
  assert.equal(verified.hookRunner, commands.runner);
  assert.equal(verified.skillCli, commands.cli);
  const original = await readFile(path.join(active.root, "bin", "acc.mjs"));
  await writeFile(path.join(active.root, "bin", "acc.mjs"), "// different artifact\n");
  await assert.rejects(verifyInstalledCommands(input), /generation.*bytes/);
  await writeFile(path.join(active.root, "bin", "acc.mjs"), original);
  await writeFile(commands.runner, "// arbitrary file under manager root\n");
  await assert.rejects(verifyInstalledCommands(input), /launcher/);
});

test("native capture clients disable update checks without inheriting routing state", () => {
  const env = buildClientEnvironment({ inherited: { ACC_DATA_HOME: "/host/data",
    ACC_NATIVE_DELIVERY_POLICY: "all" }, codex: "/owned/codex", toolDir: "/owned/tools",
  home: "/owned/home", codexHome: "/owned/cx" });
  assert.equal(env.ACC_NO_UPDATE_CHECK, "1");
  assert.equal(env.ACC_DATA_HOME, undefined);
  assert.equal(env.ACC_NATIVE_DELIVERY_POLICY, undefined);
});
