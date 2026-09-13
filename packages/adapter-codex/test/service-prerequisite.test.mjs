import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createCodexServiceSetup } from "../src/service-setup.mjs";
import { serviceFixture } from "./service-setup-fixture.mjs";

async function fixture(t) {
  const f = await serviceFixture(t, { binLayout: true });
  await rm(path.join(f.codexHome, "packages/standalone"), { recursive: true });
  const installs = [];
  const installStandalone = async plan => {
    installs.push(plan);
    await mkdir(path.dirname(f.managedPath), { recursive: true });
    await writeFile(f.managedPath, "installed vendor fixture", { mode: 0o755 });
  };
  const setup = createCodexServiceSetup({ run: f.run, probe: f.probe, installStandalone });
  return { ...f, ...setup, installs };
}

test("missing standalone installation is planned without downloading or starting", async t => {
  const f = await fixture(t);
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "needed");
  assert.equal(plan.requiresInstall, true);
  assert.equal(plan.cliVersion, "0.154.0");
  assert.equal(f.installs.length, 0);
  assert.equal(f.starts.length, 0);
});

test("approved prerequisite setup installs the matching version then verifies a service", async t => {
  const f = await fixture(t);
  const originalCli = await readFile(f.cliPath);
  const plan = await f.inspectNativeServiceSetup(f.context);
  const result = await f.prepareNativeServiceSetup({ context: f.context, plan, installPrerequisites: true });
  assert.equal(result.state, "ready");
  assert.equal(result.installedPrerequisite, true);
  assert.equal(result.started, true);
  assert.equal(f.installs.length, 1);
  assert.equal(f.installs[0].cliVersion, "0.154.0");
  assert.equal(f.installs[0].codexHome, f.codexHome);
  assert.deepEqual(await readFile(f.cliPath), originalCli);
  assert.equal(f.starts.length, 1);
  assert.ok(f.requests.includes("initialize"));
  assert.ok(f.requests.includes("thread/loaded/list"));
  const repeated = await f.inspectNativeServiceSetup(f.context);
  assert.equal((await f.prepareNativeServiceSetup({ context: f.context, plan: repeated })).state, "ready");
  assert.equal(f.installs.length, 1);
  assert.equal(f.starts.length, 1);
});

test("service-start consent alone does not download a vendor installation", async t => {
  const f = await fixture(t);
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "needed");
  const result = await f.prepareNativeServiceSetup({ context: f.context, plan });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "prerequisite_consent_required");
  assert.equal(f.installs.length, 0);
  assert.equal(f.starts.length, 0);
});

for (const change of ["cli", "home", "pid", "current"]) {
  test(`changed ${change} blocks prerequisite installation`, async t => {
    const f = await fixture(t);
    const plan = await f.inspectNativeServiceSetup(f.context);
    assert.equal(plan.state, "needed");
    let context = f.context;
    if (change === "cli") await writeFile(f.cliPath, "changed CLI");
    if (change === "home") context = { ...context, home: path.join(f.root, "other") };
    if (change === "pid") await f.writePid();
    if (change === "current") await mkdir(path.join(f.codexHome, "packages/standalone/current"), { recursive: true });
    const result = await f.prepareNativeServiceSetup({ context, plan, installPrerequisites: true });
    assert.equal(result.state, "blocked");
    assert.equal(f.installs.length, 0);
    assert.equal(f.starts.length, 0);
  });
}

test("a new Codex home through a symlinked parent retains its planned identity", async t => {
  const f = await fixture(t);
  await rm(f.codexHome, { recursive: true });
  const alias = path.join(f.root, "home-alias");
  await symlink(f.context.home, alias);
  const context = { ...f.context, env: { ...f.context.env, CODEX_HOME: path.join(alias, ".codex") } };
  const plan = await f.inspectNativeServiceSetup(context);
  assert.equal(plan.state, "needed");
  assert.equal(plan.codexHome, f.codexHome);
  // Normal adapter configuration creates CODEX_HOME after detection.
  await mkdir(path.dirname(f.socketPath), { recursive: true });
  await mkdir(path.dirname(f.pidPath), { recursive: true });
  const result = await f.prepareNativeServiceSetup({ context, plan, installPrerequisites: true });
  assert.equal(result.state, "ready");
  assert.equal(f.installs.length, 1);
});

test("failed vendor installation preserves the inbox fallback without starting", async t => {
  const f = await fixture(t);
  const setup = createCodexServiceSetup({ run: f.run, probe: f.probe,
    installStandalone: async () => { throw Object.assign(new Error("private vendor failure"),
      { reasonCode: "prerequisite_install_failed" }); } });
  const plan = await setup.inspectNativeServiceSetup(f.context);
  const result = await setup.prepareNativeServiceSetup({ context: f.context, plan, installPrerequisites: true });
  assert.equal(result.state, "failed");
  assert.equal(result.started, false);
  assert.equal(result.installedPrerequisite, false);
  assert.doesNotMatch(result.diagnostic, /private vendor failure/);
  assert.equal(f.starts.length, 0);
});

for (const change of ["wrong-version", "missing-binary", "changed-cli"]) {
  test(`vendor success with ${change} cannot start a service`, async t => {
    const f = await fixture(t);
    const setup = createCodexServiceSetup({ run: f.run, probe: f.probe, installStandalone: async () => {
      if (change !== "missing-binary") {
        await mkdir(path.dirname(f.managedPath), { recursive: true });
        await writeFile(f.managedPath, "fixture", { mode: 0o755 });
      }
      if (change === "wrong-version") f.state.managedVersion = "0.153.4";
      if (change === "changed-cli") await writeFile(f.cliPath, "changed executable");
    } });
    const plan = await setup.inspectNativeServiceSetup(f.context);
    const result = await setup.prepareNativeServiceSetup({ context: f.context, plan, installPrerequisites: true });
    assert.equal(result.state, "failed");
    assert.equal(result.started, false);
    assert.equal(f.starts.length, 0);
  });
}

for (const entry of ["symlink", "writable"]) {
  test(`an unsafe ${entry} standalone directory prevents download`, async t => {
    const f = await fixture(t);
    const root = path.join(f.codexHome, "packages/standalone");
    if (entry === "symlink") await symlink(f.root, root);
    else { await mkdir(root); await chmod(root, 0o777); }
    const plan = await f.inspectNativeServiceSetup(f.context);
    assert.equal(plan.state, "blocked");
    assert.equal(plan.reasonCode, "unsafe_service_directory");
    assert.equal(f.installs.length, 0);
  });
}
