import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ACC_PLUGIN_NAME, ACC_SKILL_ID, detectAntigravity, doctorAntigravity,
  installAntigravity, planAntigravityInstall, pluginInstallPath, uninstallAntigravity,
  vendorManifestPath } from "../src/install.mjs";
import { fakeAgy } from "./fake-agy.mjs";

const exists = async target => stat(target).then(() => true, () => false);

async function machine(t, agyOptions) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-agy-skill-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".gemini", "config"), { recursive: true });
  const agy = fakeAgy(agyOptions);
  const context = { home, dataHome: path.join(home, "acc-data"),
    antigravityWorkspace: path.join(home, "project"), runAgy: agy.run };
  return { home, context, agy };
}

const installedSkill = home => path.join(pluginInstallPath(home), "skills", "acc", "SKILL.md");

test("install gives this client its own ACC skill, through agy plugin install", async t => {
  const { home, context, agy } = await machine(t);

  await installAntigravity(context);

  assert.equal(agy.calls.some(call => call.args[0] === "plugin" && call.args[1] === "install"),
    true, "the skill must be installed the way this client manages plugins");
  const skill = await readFile(installedSkill(home), "utf8");
  assert.doesNotMatch(skill, /\{\{ACC\}\}/, "a placeholder reached the agent");
  // The command it teaches is ACC's own, under the Antigravity shim directory -
  // never the Gemini CLI extension's, which is what the copy this client makes
  // by itself points at, and which is gone the moment Gemini CLI is retired.
  const commands = [...skill.matchAll(/"([^"]+acc-cli\.sh)"/g)].map(match => match[1]);
  assert.equal(commands.length > 0, true, "the skill teaches no runnable command");
  for (const command of new Set(commands)) {
    assert.equal(command, path.join(home, ".gemini", "config", "acc", "acc-cli.sh"));
    assert.equal(await exists(command), true, `${command} does not exist`);
  }
});

test("the plugin is named so that the imported Gemini copy cannot shadow it", async t => {
  // Captured: a plugin named agents-can-communicate installed beside this
  // client's own auto-imported copy of ACC's Gemini extension was silently
  // shadowed - /skills listed only the imported one.
  assert.notEqual(ACC_PLUGIN_NAME, "agents-can-communicate");
  const { home, context } = await machine(t);
  await mkdir(path.join(home, ".gemini", "antigravity-cli", "plugins",
    "agents-can-communicate", "skills", "acc"), { recursive: true });

  await installAntigravity(context);

  assert.equal(ACC_SKILL_ID, `${ACC_PLUGIN_NAME}:acc`);
});

test("a skill the client does not list is a failed install", async t => {
  const { context } = await machine(t);
  // The client answered, and ACC's skill was not in what it answered.
  const run = async (args, options) => (args[1] === "/skills"
    ? { stdout: JSON.stringify({ status: "SUCCESS",
      command: { name: "skills", data: { skills: [] } } }) }
    : context.runAgy(args, options));

  await assert.rejects(() => installAntigravity({ ...context, runAgy: run }),
    error => /skill/.test(error.message) && /not/.test(error.message),
    "install treated a copied plugin directory as a loaded skill");
});

test("agy is always run against the home being installed into", async t => {
  const { home, context, agy } = await machine(t);

  await installAntigravity(context);
  await doctorAntigravity(context);
  await uninstallAntigravity(context);

  assert.equal(agy.calls.length > 0, true);
  for (const call of agy.calls) {
    assert.equal(call.home, home,
      `agy ${call.args.join(" ")} ran against ${call.home}, which is not the home ACC wrote`);
  }
});

test("uninstall removes the plugin and the manifest agy leaves behind", async t => {
  const { home, context, agy } = await machine(t);
  await installAntigravity(context);
  assert.equal(await exists(vendorManifestPath(home)), true);

  await uninstallAntigravity(context);

  assert.equal(agy.calls.some(call => call.args.join(" ")
    === `plugin uninstall ${ACC_PLUGIN_NAME}`), true);
  assert.equal(await exists(pluginInstallPath(home)), false);
  // agy uninstall leaves {"imports": null} in a file that did not exist before
  // ACC installed. It was ACC's install that caused it, so it goes too.
  assert.equal(await exists(vendorManifestPath(home)), false,
    "uninstall left agy's empty manifest behind");
});

test("a plugin manifest that was already there is left alone", async t => {
  const { home, context } = await machine(t);
  const theirs = { imports: [{ name: "their-plugin", source: "antigravity",
    components: ["skills"] }] };
  await writeFile(vendorManifestPath(home), `${JSON.stringify(theirs, null, 2)}\n`);

  await installAntigravity(context);
  await uninstallAntigravity(context);

  assert.deepEqual(JSON.parse(await readFile(vendorManifestPath(home), "utf8")), theirs);
});

test("the plan names the plugin and the manifest as removed by the adapter", async t => {
  const { home, context } = await machine(t);

  const plan = planAntigravityInstall(context);

  // Delegated, never deleted by the installer first: agy owns the copy and its
  // manifest entry, and removing the directory ahead of `agy plugin uninstall`
  // would strand that entry - the same ordering that once left `{}` behind.
  for (const target of [pluginInstallPath(home), vendorManifestPath(home)]) {
    const artifact = plan.find(item => item.path === target);
    assert.ok(artifact, `${target} is written by install and missing from the plan`);
    assert.equal(artifact.kind, "merge");
  }
});

test("doctor names the imported Gemini copy and what it depends on", async t => {
  const { home, context } = await machine(t);
  await mkdir(path.join(home, ".gemini", "antigravity-cli", "plugins",
    "agents-can-communicate", "skills", "acc"), { recursive: true });
  await installAntigravity(context);

  const report = await doctorAntigravity(context);

  assert.equal(report.diagnostics.some(line => line.includes(ACC_SKILL_ID)
    && /registered/.test(line) && !/not registered/.test(line)), true);
  assert.equal(report.diagnostics.some(line => /agents-can-communicate:acc/.test(line)
    && /Gemini CLI/.test(line)), true,
  "the model sees two ACC skills here; say which one is ACC's and what the other rests on");
});

test("detect asks for a reinstall when the hooks load and the skill does not", async t => {
  const { context } = await machine(t);
  await installAntigravity(context);
  await rm(pluginInstallPath(context.home), { recursive: true, force: true });

  const detected = await detectAntigravity(context);

  assert.equal(detected.needsAction?.some(line => /acc install --adapter antigravity/.test(line)),
    true, "a missing skill must reach doctor's remediation, not only a diagnostic");
});

test("a home with no signed-in account is reported as unverifiable, not as installed", async t => {
  const { context } = await machine(t, { authenticated: false });

  const result = await installAntigravity(context);

  assert.equal(result.diagnostics.some(line => /could not|sign/i.test(line)), true);
  assert.equal(result.diagnostics.some(line => /^acc (hooks|skill) registered/.test(line)),
    false, "an unanswerable client is not evidence of registration");
});

test("detection does not run a client the installer did not find", async t => {
  const { context, agy } = await machine(t);

  // The installer runs every adapter's detect, whether or not its client is on
  // the machine, and passes a null version for one that is not. Spawning agy
  // then is at best a wasted process on every `acc install` and `acc doctor`,
  // and at worst the binary writing its own state into a home it was never
  // asked about - captured: agy creates .gemini/antigravity-cli and
  // Library/Caches in whatever HOME it is given.
  const detected = await detectAntigravity({ ...context, clientVersion: null });

  assert.deepEqual(agy.calls, [], "agy was run although the installer found no agy");
  assert.equal(detected.diagnostics.some(line => /not registered/.test(line)), true);
});
