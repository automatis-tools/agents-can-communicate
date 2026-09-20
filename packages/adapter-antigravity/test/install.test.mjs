import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { ACC_NAMESPACE, ACC_REGISTERED_EVENTS, HOOK_LOCATIONS, detectAntigravity,
  doctorAntigravity, globalHooksPath, installAntigravity, planAntigravityInstall,
  registeredEvents, uninstallAntigravity, workspaceHooksPath } from "../src/install.mjs";

const captured = async name => JSON.parse(await readFile(
  new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

// What the Gemini CLI integration owns in the shared ~/.gemini tree. Both
// clients read this directory, and nothing here may be touched by the other's
// install, uninstall or doctor.
const GEMINI_SETTINGS = { theme: "dark", hooks: {
  BeforeAgent: [{ matcher: "*", hooks: [{ name: "acc-beforeTurn", type: "command",
    command: "sh /somewhere/acc-hook.sh beforeTurn" }] }] } };

async function fixture(t, { location } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-agy-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, "project");
  await mkdir(path.join(home, ".gemini", "extensions", "agents-can-communicate"),
    { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(home, ".gemini", "settings.json"),
    `${JSON.stringify(GEMINI_SETTINGS, null, 2)}\n`);
  await writeFile(path.join(home, ".gemini", "extensions", "agents-can-communicate",
    "gemini-extension.json"), "{\"name\":\"agents-can-communicate\"}\n");
  // Registration succeeded, unless a test says otherwise.
  const probeHooks = async () => ({ hooks: [{ name: ACC_NAMESPACE, enabled: true,
    source: location === "workspace" ? workspaceHooksPath(workspace) : globalHooksPath(home),
    actions: ACC_REGISTERED_EVENTS.map(event => ({ event, type: "command",
      command: "sh /shim/acc-hook.sh " + event, timeout_seconds: 10 })) }] });
  const context = { home, antigravityWorkspace: workspace,
    ...(location === undefined ? {} : { antigravityHookLocation: location }), probeHooks };
  const geminiTree = async () => ({
    settings: await readFile(path.join(home, ".gemini", "settings.json"), "utf8"),
    extension: await readdir(path.join(home, ".gemini", "extensions",
      "agents-can-communicate")),
  });
  return { home, workspace, context, geminiTree };
}

const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const missing = async file => {
  try {
    await stat(file);
    return false;
  } catch {
    return true;
  }
};

test("the registration location has no default and must be chosen", async t => {
  const { context } = await fixture(t);

  await assert.rejects(() => installAntigravity(context),
    error => error.code === EXIT.USAGE
      && /global|workspace/.test(error.message),
    "an unchosen location must refuse rather than pick one");
  assert.deepEqual([...HOOK_LOCATIONS], ["global", "workspace"]);
});

test("install writes the namespaced schema, which is the only one that loads", async t => {
  const { home, context } = await fixture(t, { location: "global" });

  await installAntigravity(context);

  const written = await readJson(globalHooksPath(home));
  assert.deepEqual(Object.keys(written), [ACC_NAMESPACE]);
  assert.deepEqual(Object.keys(written[ACC_NAMESPACE]).sort(),
    [...ACC_REGISTERED_EVENTS].sort());
  for (const [event, actions] of Object.entries(written[ACC_NAMESPACE])) {
    assert.equal(Array.isArray(actions), true);
    assert.equal(actions[0].type, "command");
    assert.equal(actions[0].command.endsWith(` ${event}`), true,
      `${event} must carry its own name, because the payload does not`);
    // Quoted, because a home directory may contain a space, and absolute,
    // because a hook environment carries no PATH. A quoted command loads:
    // captured on 1.2.7 with a space in the path.
    assert.match(actions[0].command, /^sh "\/[^"]+\/acc-hook\.sh" /,
      "the shim must be named by an absolute, quoted path");
    assert.equal("matcher" in actions[0], false,
      "matcher is a Gemini CLI field; this client drops an entry that carries it");
    assert.equal("hooks" in actions[0], false,
      "a nested hooks array is the Gemini CLI shape and loads nothing here");
  }
});

test("install can write the workspace file instead", async t => {
  const { home, workspace, context } = await fixture(t, { location: "workspace" });

  const result = await installAntigravity(context);

  assert.equal(await missing(globalHooksPath(home)), true,
    "a workspace install must not create the machine-wide file");
  const written = await readJson(workspaceHooksPath(workspace));
  assert.deepEqual(Object.keys(written), [ACC_NAMESPACE]);
  assert.equal(result.changes.includes(workspaceHooksPath(workspace)), true);
  assert.equal(result.diagnostics.some(line => /open workspace|--add-dir/.test(line)), true,
    "a workspace registration is inert unless the folder is open; say so");
});

test("a write that registered nothing is a failed install, not a successful one", async t => {
  const { context } = await fixture(t, { location: "global" });
  // Exactly what this client answers for the Gemini-shaped config ACC writes
  // today, and for a config wrapped in a top-level `hooks` key: the file is on
  // disk, it parsed, and the effective hook list is empty.
  const geminiShape = await captured("hooks-readback-gemini-shape-1.2.7");

  await assert.rejects(
    () => installAntigravity({ ...context, probeHooks: async () => geminiShape }),
    error => /registered nothing|not registered/i.test(error.message),
    "install treated a successful write as a successful registration");
});

test("an event this client silently drops fails the install that asked for it", async t => {
  const { context } = await fixture(t, { location: "global" });
  const dropped = await captured("hooks-readback-dropped-1.2.7");

  await assert.rejects(
    () => installAntigravity({ ...context, probeHooks: async () => dropped }),
    error => /PreInvocation|Stop/.test(error.message),
    "a partial registration must name the events that did not load");
});

test("registeredEvents reads the effective list, never the file that was written", async () => {
  assert.deepEqual(registeredEvents(await captured("hooks-readback-empty-1.2.7")), []);
  assert.deepEqual(registeredEvents(await captured("hooks-readback-gemini-shape-1.2.7")), []);
  assert.deepEqual(registeredEvents(await captured("hooks-readback-dropped-1.2.7")),
    ["SessionStart"]);
  assert.deepEqual(registeredEvents(await captured("hooks-readback-registered-1.2.7")),
    ["SessionStart", "PreInvocation", "Stop"]);
  // A namespace belonging to somebody else is not ACC's registration.
  assert.deepEqual(registeredEvents({ hooks: [{ name: "someone-else", enabled: true,
    actions: [{ event: "SessionStart" }] }] }), []);
  // Disabled is on disk and inert, which is the whole distinction this makes.
  assert.deepEqual(registeredEvents({ hooks: [{ name: ACC_NAMESPACE, enabled: false,
    actions: [{ event: "SessionStart" }] }] }), []);
});

test("uninstall leaves the Gemini CLI integration byte-identical", async t => {
  const { home, context, geminiTree } = await fixture(t, { location: "global" });
  const before = await geminiTree();

  await installAntigravity(context);
  await uninstallAntigravity(context);

  assert.deepEqual(await geminiTree(), before,
    "the two clients share ~/.gemini; this install touched the other one");
  assert.equal(await missing(globalHooksPath(home)), true,
    "ACC created this file and must take it away with it");
});

test("uninstall keeps a hooks.json that was not ACC's to delete", async t => {
  const { home, context } = await fixture(t, { location: "global" });
  const theirs = { "their-tool": { SessionStart: [{ type: "command", command: "their-hook" }] } };
  await mkdir(path.dirname(globalHooksPath(home)), { recursive: true });
  await writeFile(globalHooksPath(home), `${JSON.stringify(theirs, null, 2)}\n`);

  await installAntigravity(context);
  await uninstallAntigravity(context);

  assert.deepEqual(await readJson(globalHooksPath(home)), theirs,
    "removing ACC's namespace must leave every other namespace exactly as it was");
});

test("detect names the plugin-directory-present, nothing-registered state", async t => {
  const { home, context } = await fixture(t, { location: "global" });
  // What AGY does on its first authenticated run: it copies the ACC Gemini CLI
  // extension in whole and registers none of it. Issue #176.
  await mkdir(path.join(home, ".gemini", "antigravity-cli", "plugins",
    "agents-can-communicate"), { recursive: true });

  const detected = await detectAntigravity({ ...context,
    probeHooks: async () => ({ hooks: [] }) });

  assert.equal(detected.diagnostics.some(line => /not registered/.test(line)), true);
  assert.equal(detected.diagnostics.some(line =>
    /imported.*plugin|plugin directory/i.test(line)), true,
  "a copied plugin directory looks like an install and is not one; say which");
});

test("doctor reports the effective registration, not the file it wrote", async t => {
  const { home, context } = await fixture(t, { location: "global" });
  await installAntigravity(context);
  // The file still says everything is registered. The client says otherwise:
  // vendor 1.2.4 fixed hooks.json being dropped under token budget truncation,
  // and 1.1.1 fixed workspace hooks not loading after trusting a folder.
  const report = await doctorAntigravity({ ...context, probeHooks: async () => ({ hooks: [] }) });

  assert.equal((await readJson(globalHooksPath(home)))[ACC_NAMESPACE] !== undefined, true);
  assert.equal(report.diagnostics.some(line => /not registered/.test(line)), true,
    "doctor trusted the file it wrote instead of the client's own answer");
});

test("doctor says so when the client cannot be asked, and claims nothing", async t => {
  const { context } = await fixture(t, { location: "global" });
  await installAntigravity(context);

  const report = await doctorAntigravity({ ...context,
    probeHooks: async () => { throw new Error("agy: command not found"); } });

  assert.equal(report.diagnostics.some(line => /could not/i.test(line)), true);
  assert.equal(report.diagnostics.some(line => /^acc hooks registered$/.test(line)), false,
    "an unanswerable probe is not evidence of registration");
});

test("the plan names exactly the paths the install writes", async t => {
  for (const location of HOOK_LOCATIONS) {
    const { context } = await fixture(t, { location });
    const planned = planAntigravityInstall(context).map(artifact => artifact.path).sort();

    const applied = (await installAntigravity(context)).changes.sort();

    assert.deepEqual(applied, planned,
      `${location}: a plan that drifts makes --dry-run a decoration`);
  }
});

test("nothing ACC writes into the file is anything but a namespace", async t => {
  const { home, context } = await fixture(t, { location: "global" });

  await installAntigravity(context);

  // One top-level key this client cannot read as a namespace drops the whole
  // file, valid namespaces included - captured on 1.2.7 with the very marker
  // the Gemini CLI adapter writes into settings.json. So the bookkeeping that
  // says "ACC created this file" lives beside the shim, not inside the file.
  const written = await readJson(globalHooksPath(home));
  for (const [key, value] of Object.entries(written)) {
    assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true,
      `${key} is not an event map, and this client drops a file that holds one`);
    for (const actions of Object.values(value)) {
      assert.equal(Array.isArray(actions), true, `${key} holds a non-array event`);
    }
  }
});

test("a file ACC created goes away with it; a file it did not stays", async t => {
  const created = await fixture(t, { location: "global" });
  await installAntigravity(created.context);
  await uninstallAntigravity(created.context);
  assert.equal(await missing(globalHooksPath(created.home)), true);

  const theirs = await fixture(t, { location: "global" });
  await mkdir(path.dirname(globalHooksPath(theirs.home)), { recursive: true });
  await writeFile(globalHooksPath(theirs.home), "{}\n");
  await installAntigravity(theirs.context);
  await uninstallAntigravity(theirs.context);
  assert.equal(await missing(globalHooksPath(theirs.home)), false,
    "an empty file the user made is still the user's file");
  assert.equal(await readFile(globalHooksPath(theirs.home), "utf8"), "{}\n",
    "uninstall must restore the user's file byte for byte");
});

test("uninstall removes an ACC registration from either location", async t => {
  for (const location of HOOK_LOCATIONS) {
    const { home, workspace, context } = await fixture(t, { location });
    await installAntigravity(context);

    await uninstallAntigravity(context);

    assert.equal(await missing(globalHooksPath(home)), true, `${location}: global left behind`);
    assert.equal(await missing(workspaceHooksPath(workspace)), true,
      `${location}: workspace left behind`);
  }
});
