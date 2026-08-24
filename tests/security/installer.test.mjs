import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";
import { ALL_ADAPTERS, clientContext } from "@agents-can-communicate/cli";
import { applyPlan, loadOwnership, planInstallation, recordInstall, removeOwned }
  from "@agents-can-communicate/installer";
import { EXIT } from "@agents-can-communicate/protocol";

/**
 * The installer edits files ACC does not own.
 *
 * It runs with the user's rights, touches configuration for four other tools,
 * and can be asked to undo itself later. The risk is not that it installs
 * badly - it is that uninstall deletes something that was never ACC's, on the
 * strength of a path or a record it half-recognises.
 */
async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-sec-inst-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-sec-data-")));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  await writeFile(path.join(home, "config.toml"), 'default_model = "k3"\n');
  return { home, dataHome, context: { home, dataHome } };
}

const kimiPlan = context => planInstallation({ adapters: [createKimiAdapter()],
  detected: [{ adapterId: "kimi", displayName: "Kimi Code", present: true,
    version: "0.36.1", installed: false, diagnostics: [], capabilities: {}, error: null }],
  context });

test("uninstall never deletes a file the record does not match", async t => {
  const { dataHome, home } = await machine(t);
  const unrelated = path.join(home, "important.json");
  await writeFile(unrelated, '{"mine":true}\n');

  // A record that claims someone else's file - stale, hand-edited, or planted.
  await recordInstall({ dataHome, adapterId: "kimi", version: "0.0.0",
    artifacts: [{ path: unrelated, kind: "file" }] });
  await writeFile(unrelated, '{"mine":true,"changed":true}\n');

  const result = await removeOwned({ dataHome, adapterId: "kimi" });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, [unrelated]);
  assert.match(await readFile(unrelated, "utf8"), /changed/);
});

test("a record naming a path ACC never wrote cannot delete it", async t => {
  const { dataHome, home } = await machine(t);
  const victim = path.join(home, "config.toml");
  const original = await readFile(victim, "utf8");

  // Recording without ever writing: the hash is of the user's own file, so it
  // would match. This is the case where content alone is not enough, and the
  // answer is that ACC only ever records what its own install just wrote.
  await recordInstall({ dataHome, adapterId: "kimi", version: "0.0.0",
    artifacts: [{ path: victim, kind: "merge" }] });

  const result = await removeOwned({ dataHome, adapterId: "kimi" });

  // A merge artifact is never deleted - the user owns the file and ACC owns
  // some entries inside it.
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.delegated, [victim]);
  assert.equal(await readFile(victim, "utf8"), original);
});

test("a corrupt record stops the run instead of silently emptying", async t => {
  const { dataHome } = await machine(t);
  await mkdir(path.join(dataHome, "acc"), { recursive: true });
  await writeFile(path.join(dataHome, "acc", "installs.json"), "{ broken\n");

  // Treating it as empty would orphan every file ACC has written on this
  // machine, and the next install would write a fresh record over the evidence.
  await assert.rejects(loadOwnership({ dataHome }), error => error.code === EXIT.DATA);
});

test("an install refuses to wire a runner that does not exist", async t => {
  const { home } = await machine(t);

  // A hook command that cannot be executed fails silently on every event. It is
  // also the shape of a supply-chain mistake: a path that resolves to nothing
  // today may resolve to something else tomorrow.
  await assert.rejects(
    createKimiAdapter().install({ home, runner: "/nonexistent/acc-hook.mjs" }),
    error => error.code === EXIT.DATA && /runner/.test(error.message));
});

test("uninstall leaves a directory the user has put work into", async t => {
  const { context, dataHome, home } = await machine(t);
  const adapters = [createKimiAdapter()];
  await applyPlan({ plan: kimiPlan(context), adapters, context, dataHome });

  const plugin = path.join(home, "plugins", "managed", "agents-can-communicate");
  await writeFile(path.join(plugin, "skills", "acc", "SKILL.md"), "my notes\n");

  await applyPlan({ plan: planInstallation({ adapters,
    detected: [{ adapterId: "kimi", displayName: "Kimi Code", present: true,
      version: "0.36.1", installed: true, diagnostics: [], capabilities: {},
      error: null }], context, action: "uninstall" }),
    adapters, context, dataHome });

  assert.equal(await readFile(path.join(plugin, "skills", "acc", "SKILL.md"), "utf8"),
    "my notes\n");
});

test("install and uninstall restore a foreign config byte for byte", async t => {
  const { context, dataHome, home } = await machine(t);
  const adapters = [createKimiAdapter()];
  const original = await readFile(path.join(home, "config.toml"), "utf8");

  await applyPlan({ plan: kimiPlan(context), adapters, context, dataHome });
  await applyPlan({ plan: planInstallation({ adapters,
    detected: [{ adapterId: "kimi", displayName: "Kimi Code", present: true,
      version: "0.36.1", installed: true, diagnostics: [], capabilities: {},
      error: null }], context, action: "uninstall" }),
    adapters, context, dataHome });

  // The user's settings are the asset here. A tool that edits them must be able
  // to prove it can put them back.
  assert.equal(await readFile(path.join(home, "config.toml"), "utf8"), original);
});

/**
 * The user's own entries in a container ACC had to create.
 *
 * Recording ownership per entry exists so uninstall leaves `enabledPlugins`
 * alone except for ACC's line. Creating the container undid that: it was also
 * recorded as a whole owned key, so uninstall removed the key outright - and
 * every plugin the user had enabled since the install went with it. The record
 * that would have saved them was there, and the coarser one won.
 */
async function claudeHome(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-sec-claude-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const context = clientContext(home);
  const settings = path.join(context.configDir, "settings.json");
  const adapter = ALL_ADAPTERS().find(item => item.id === "claude_code");
  const read = async () => JSON.parse(await readFile(settings, "utf8"));
  return { adapter, context, settings, read };
}

test("uninstall keeps plugins the user enabled after the install", async t => {
  const { adapter, context, settings, read } = await claudeHome(t);
  await adapter.install(context);

  // Enabling a plugin is the ordinary next thing a user does, and the client
  // writes it into the same key ACC just created.
  const mine = await read();
  mine.enabledPlugins["their-plugin@their-marketplace"] = true;
  await writeFile(settings, `${JSON.stringify(mine, null, 2)}\n`);

  await adapter.uninstall(context);

  const after = await read();
  assert.deepEqual(after.enabledPlugins, { "their-plugin@their-marketplace": true },
    "uninstall took the whole key, and the user's plugin with it");
  assert.equal(Object.hasOwn(after, "acc:createdContainers"), false);
});

test("uninstall leaves no empty container behind, nor the file that held it", async t => {
  const { adapter, context, settings } = await claudeHome(t);
  await adapter.install(context);
  await adapter.uninstall(context);

  // Nothing else ever wanted the key, and this home had no settings file before
  // the install, so the file goes with it. Keeping either would be litter in a
  // place ACC only borrowed - the same standard as restoring a config byte for
  // byte. Which of the two happens depends on whether ACC created the file, and
  // the install records that because afterwards `{}` looks identical either way.
  assert.equal(await readFile(settings, "utf8").then(() => true, () => false), false,
    "a settings file ACC created and then emptied was left behind");
});

test("a container the user already had survives uninstall", async t => {
  const { adapter, context, settings, read } = await claudeHome(t);
  await mkdir(context.configDir, { recursive: true });
  // Empty, and theirs. ACC adds an entry to it rather than creating it, so
  // uninstall has to hand back the empty object it found.
  await writeFile(settings, `${JSON.stringify({ enabledPlugins: {} }, null, 2)}\n`);

  await adapter.install(context);
  await adapter.uninstall(context);

  assert.deepEqual(await read(), { enabledPlugins: {} });
});

test("a dry run cannot be tricked into writing", async t => {
  const { context, dataHome, home } = await machine(t);
  const before = await readFile(path.join(home, "config.toml"), "utf8");

  await applyPlan({ plan: kimiPlan(context), adapters: [createKimiAdapter()],
    context, dataHome, dryRun: true });

  assert.equal(await readFile(path.join(home, "config.toml"), "utf8"), before);
  assert.deepEqual((await loadOwnership({ dataHome })).installs, []);
});
