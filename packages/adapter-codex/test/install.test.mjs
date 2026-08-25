import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CODEX_PLUGIN, pluginVersion } from "../../../tests/helpers/plugin-version.mjs";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCodexAdapter } from "../src/adapter.mjs";
import { CODEX_HOOK_EVENTS, injectOutcome, normalizeCodexHook } from "../src/hooks.mjs";

// A marketplace the user already owns, in the shape this client actually
// parses. `plugins` is a sequence; a map is rejected and takes the whole file
// with it, so the earlier map-shaped fixture was testing a format that could
// never have worked.
const EXISTING = {
  name: "local-marketplace",
  interface: { displayName: "Local Plugins" },
  plugins: [{ name: "someone-elses-plugin",
    source: { source: "local", path: "./plugins/someone-elses-plugin" },
    policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_INSTALL" },
    category: "Coding" }],
};

const named = (marketplace, name) =>
  marketplace.plugins.find(entry => entry.name === name);

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const marketplace = path.join(home, ".agents", "plugins", "marketplace.json");
  await mkdir(path.dirname(marketplace), { recursive: true });
  await writeFile(marketplace, `${JSON.stringify(EXISTING, null, 2)}\n`);
  // The user's, which ACC has no business in - and ACC's own, at a root of its
  // making. Sharing the user's marketplace was the whole defect: this client
  // discovers it with no config entry, under whatever its manifest calls
  // itself, so ACC's id never matched and its plugin sat there `not installed`.
  const theirs = async () => JSON.parse(await readFile(marketplace, "utf8"));
  const root = path.join(home, ".agents", "acc-local");
  const ours = path.join(root, ".agents", "plugins", "marketplace.json");
  const read = async () => JSON.parse(await readFile(ours, "utf8"));
  const plugin = path.join(root, "plugins", "agents-can-communicate");
  return { context: { home, codexHome: path.join(home, ".codex") },
    marketplace: ours, read, theirs, root, plugin };
}

test("install places the plugin and registers it in the marketplace", async t => {
  const { context, read, theirs, plugin } = await fixture(t);

  const result = await createCodexAdapter().install(context);

  assert.equal(result.ok, true);
  assert.deepEqual((await readdir(plugin)).sort(),
    [".codex-plugin", "acc-hook.sh", "hooks.json", "skills"].sort());
  const manifest = JSON.parse(await readFile(
    path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.hooks, "./hooks.json");
  assert.equal(named(await read(), "agents-can-communicate") !== undefined, true);
});

test("install is idempotent and leaves the user's own plugin alone", async t => {
  const { context, read, theirs } = await fixture(t);
  const adapter = createCodexAdapter();

  await adapter.install(context);
  const afterFirst = await read();
  await adapter.install(context);

  assert.deepEqual(await read(), afterFirst, "a second install changed the marketplace");
  assert.equal(afterFirst.name, "acc-local");
  // The user's own marketplace is not ACC's to write in.
  assert.deepEqual(await theirs(), EXISTING, "ACC edited the user's marketplace");
});

test("uninstall removes only what ACC owns, twice safely", async t => {
  const { context, read, theirs } = await fixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  await adapter.uninstall(context);
  await adapter.uninstall(context);

  // ACC's marketplace is ACC's, so it goes entirely - and an empty directory
  // left behind is litter in a home that did not have one.
  await assert.rejects(readdir(path.join(context.home, ".agents", "acc-local")),
    error => error.code === "ENOENT");
  // The user's is not ACC's, and was never written to in the first place.
  assert.deepEqual(await theirs(), EXISTING, "ACC touched the user's marketplace");
});

test("the hooks file wires only events this client actually has", async t => {
  const { context } = await fixture(t);
  await createCodexAdapter().install(context);

  const wired = JSON.parse(await readFile(path.join(context.home, ".agents", "acc-local", "plugins",
    "agents-can-communicate", "hooks.json"), "utf8"));

  for (const event of Object.keys(wired.hooks)) {
    assert.equal(CODEX_HOOK_EVENTS.includes(event), true,
      `${event} is not in the 0.147.0 hook enum`);
  }
  for (const entries of Object.values(wired.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) assert.equal(hook.type, "command");
    }
  }
});

test("detect is read-only and reports registration honestly", async t => {
  const { context, read, theirs } = await fixture(t);
  const adapter = createCodexAdapter();

  const before = await adapter.detect(context);
  assert.match(before.diagnostics.join(" "), /not registered/);

  await adapter.install(context);
  const after = await adapter.detect(context);

  assert.match(after.diagnostics.join(" "), /registered/);
  assert.deepEqual(await theirs(), EXISTING, "ACC edited the user's marketplace");
});

test("only capabilities observed in a real session are declared true", () => {
  const { capabilities } = createCodexAdapter();

  // Observed firing on codex-cli 0.147.0; fixtures are in fixtures/.
  assert.equal(capabilities.lifecycle.sessionStart, true);
  assert.equal(capabilities.lifecycle.sessionEnd, true);
  assert.equal(capabilities.guards.beforeWrite, true);
  assert.equal(capabilities.guards.beforeShell, true);

  // Not observed, so not claimed: no subagent ran during the capture.
  assert.equal(capabilities.lifecycle.childSessions, false);
  assert.equal(capabilities.delivery.wakeDormantSession, false);
  for (const value of Object.values(capabilities.execution)) assert.equal(value, false);
});

test("doctor reports the capture and the trust requirement", async t => {
  const { context } = await fixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  const report = await adapter.doctor(context);

  assert.match(report.diagnostics.join(" "), /captured/);
  assert.match(report.diagnostics.join(" "), /trusted/);
});

test("the guard matches the tools this client actually uses", async t => {
  const { context } = await fixture(t);
  await createCodexAdapter().install(context);
  const wired = JSON.parse(await readFile(path.join(context.home, ".agents", "acc-local", "plugins",
    "agents-can-communicate", "hooks.json"), "utf8"));

  // Codex names its edit tool apply_patch. A matcher copied from another
  // harness's vocabulary would never fire on a file edit, and the adapter would
  // report edits as guarded while letting every one through.
  const matcher = wired.hooks.PreToolUse[0].matcher;
  assert.match(matcher, /apply_patch/);
  assert.doesNotMatch(matcher, /\bWrite\b|\bEdit\b/);
});

test("real captured payloads normalise without guesswork", async () => {
  const captured = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"];
  const kinds = { SessionStart: "sessionStart", UserPromptSubmit: "beforeTurn",
    PreToolUse: "beforeTool", Stop: "turnEnd", SessionEnd: "sessionEnd" };

  for (const event of captured) {
    const payload = JSON.parse(await readFile(new URL(`../fixtures/${event}.json`,
      import.meta.url), "utf8"));
    const normalised = normalizeCodexHook(payload);

    assert.equal(normalised.kind, kinds[event], `${event} normalised wrongly`);
    assert.equal(normalised.sessionId, payload.session_id);
    assert.equal(normalised.cwd, payload.cwd);
    // Conversation content is dropped by the whitelist, not carried along.
    assert.deepEqual(Object.keys(normalised).sort(),
      ["cwd", "kind", "model", "parentSessionId", "sessionId", "targets", "tool"]);
    assert.equal(JSON.stringify(normalised).includes("redacted"), false);
  }
});

test("an unrecognised hook payload is refused rather than guessed", () => {
  // Inventing a session from an unknown shape would attach the wrong session,
  // or a new one on every hook, and would look like it was working.
  assert.throws(() => normalizeCodexHook({ something: "else" }),
    error => error.code === EXIT.DATA);
  assert.throws(() => normalizeCodexHook({ hook_event_name: "SessionStart" }),
    error => error.code === EXIT.DATA && /session id/.test(error.message));
  assert.throws(() => normalizeCodexHook({ hook_event_name: "Imaginary",
    session_id: "s", cwd: "/tmp" }), error => error.code === EXIT.DATA);
});

test("a recognised payload normalises to the shared event shape", () => {
  const normalised = normalizeCodexHook({ hook_event_name: "PreToolUse",
    session_id: "abc-123", cwd: "/tmp/project", tool_name: "Write" });

  assert.deepEqual({ ...normalised, targets: [...normalised.targets] },
    { kind: "beforeTool", sessionId: "abc-123", cwd: "/tmp/project", model: null,
      parentSessionId: null, tool: "Write", targets: [] });
});

test("the write target is read out of the patch body, where this client puts it", async () => {
  // Unlike every other harness, this client's editor takes no path argument:
  // the paths are inside the patch. Reading tool_input.path here would find
  // nothing and leave every edit unguarded while looking correct.
  const payload = JSON.parse(await readFile(
    new URL("../fixtures/PreToolUse.json", import.meta.url), "utf8"));

  assert.deepEqual([...normalizeCodexHook(payload).targets], ["guarded.txt"]);
});

test("a patch touching several files declares all of them", () => {
  const body = ["*** Begin Patch", "*** Update File: src/a.mjs", "+one",
    "*** Add File: src/b.mjs", "+two", "*** Delete File: src/c.mjs",
    "*** Move to: src/d.mjs", "*** End Patch"].join("\n");

  const normalised = normalizeCodexHook({ hook_event_name: "PreToolUse",
    session_id: "s", cwd: "/tmp", tool_name: "apply_patch",
    tool_input: { command: body } });

  // A single call here can touch several files, so a guard that checked only
  // the first would let the rest through.
  assert.deepEqual([...normalised.targets],
    ["src/a.mjs", "src/b.mjs", "src/c.mjs", "src/d.mjs"]);
});

test("the patch's content lines are never read as paths", () => {
  // A `+` line can say anything, including something that looks like a header.
  const body = ["*** Begin Patch", "*** Add File: real.txt",
    "+*** Add File: not-a-path.txt", "*** End Patch"].join("\n");

  const normalised = normalizeCodexHook({ hook_event_name: "PreToolUse",
    session_id: "s", cwd: "/tmp", tool_name: "apply_patch",
    tool_input: { command: body } });

  assert.deepEqual([...normalised.targets], ["real.txt"]);
});

test("a shell call declares no target rather than a guessed one", () => {
  const normalised = normalizeCodexHook({ hook_event_name: "PreToolUse",
    session_id: "s", cwd: "/tmp", tool_name: "shell",
    tool_input: { command: "rm -rf src/" } });

  assert.deepEqual([...normalised.targets], []);
});

const realFixture = fixture;

test("the marketplace entry is written in the shape this client parses", async t => {
  const { context, read } = await realFixture(t);

  await createCodexAdapter().install(context);

  const marketplace = await read();
  // A map here is rejected outright - "invalid type: map, expected a sequence" -
  // and the client then fails to load the whole file, taking the user's own
  // plugins down with it.
  assert.equal(Array.isArray(marketplace.plugins), true);
  const ours = marketplace.plugins.find(entry => entry.name === "agents-can-communicate");
  assert.deepEqual(ours.source, { source: "local", path: "./plugins/agents-can-communicate" });
  // Only ON_INSTALL and ON_USE are accepted; anything else fails validation.
  assert.equal(["ON_INSTALL", "ON_USE"].includes(ours.policy.authentication), true);
  assert.equal(typeof ours.policy.installation, "string");
});

test("ACC's bookkeeping never appears as a plugin", async t => {
  const { context, read } = await realFixture(t);

  await createCodexAdapter().install(context);

  // Ownership used to be recorded as an extra key beside the plugins, which in
  // a sequence becomes a nameless entry the client tries to load.
  for (const entry of (await read()).plugins) {
    assert.equal(typeof entry.name, "string");
    assert.equal(entry.name.startsWith("acc:"), false, `${entry.name} is bookkeeping`);
  }
});

test("uninstall removes our entry and leaves the user's marketplace intact", async t => {
  const { context, theirs } = await realFixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  await adapter.uninstall(context);

  assert.deepEqual(await theirs(), EXISTING);
  await assert.rejects(readdir(path.join(context.home, ".agents", "acc-local")),
    error => error.code === "ENOENT", "ACC's own marketplace outlived the uninstall");
});

test("install registers the marketplace and enables the plugin", async t => {
  const { context } = await realFixture(t);

  await createCodexAdapter().install(context);

  // Placing files is not installing. Without these two, the client never lists
  // the plugin and no hook ever runs - the install looks successful and does
  // nothing at all.
  const config = await readFile(path.join(context.codexHome, "config.toml"), "utf8");
  assert.match(config, /\[marketplaces\.acc-local\]/);
  assert.match(config, /source_type = "local"/);
  assert.match(config, /\[plugins\."agents-can-communicate@acc-local"\]/);
  assert.match(config, /enabled = true/);
});

test("uninstall takes the config registration back out", async t => {
  const { context } = await realFixture(t);
  const adapter = createCodexAdapter();
  const configFile = path.join(context.codexHome, "config.toml");
  await writeFile(configFile, "model = \"gpt-5\"\n").catch(() => {});
  await mkdir(context.codexHome, { recursive: true });
  await writeFile(configFile, "model = \"gpt-5\"\n");

  await adapter.install(context);
  await adapter.uninstall(context);

  assert.equal(await readFile(configFile, "utf8"), "model = \"gpt-5\"\n");
});

test("detect names the client's own command if the cache is gone", async t => {
  const { context } = await realFixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  // Publishing, registering and enabling are all necessary and still not
  // sufficient: hooks stay silent unless the plugin is in the client's cache.
  // ACC writes that copy now, so this is the state after someone clears the
  // cache or the client changes where it keeps one - and then the supported
  // command is the answer to name.
  await rm(path.join(context.codexHome, "plugins", "cache"),
    { recursive: true, force: true });

  const said = (await adapter.detect(context)).diagnostics.join(" ");
  assert.match(said, /codex plugin add agents-can-communicate@acc-local/);
  assert.match(said, /not installed/);
});

test("detect reports the plugin as installed once the client has cached it", async t => {
  const { context } = await realFixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  // What `codex plugin add` leaves behind.
  await mkdir(path.join(context.codexHome, "plugins", "cache", "acc-local",
    "agents-can-communicate", await pluginVersion(CODEX_PLUGIN)), { recursive: true });

  assert.match((await adapter.detect(context)).diagnostics.join(" "),
    /plugin installed in the client's cache/);
});

test("install refuses rather than duplicating a marketplace the user already added", async t => {
  const { context } = await realFixture(t);
  const config = path.join(context.codexHome, "config.toml");
  await mkdir(context.codexHome, { recursive: true });
  // What `codex plugin marketplace add` writes if the user ran it themselves.
  await writeFile(config, '[marketplaces.acc-local]\nsource_type = "local"\n');

  // Appending our block on top produces a duplicate table, and this client then
  // refuses to load the config at all - every plugin the user has stops working.
  await assert.rejects(createCodexAdapter().install(context),
    error => /already registered/.test(error.message));

  assert.equal(await readFile(config, "utf8"),
    '[marketplaces.acc-local]\nsource_type = "local"\n');
});

test("install finishes the job the client's own command would have done", async t => {
  const { context } = await realFixture(t);

  await createCodexAdapter().install(context);

  // `codex plugin add` does exactly one thing: copies the plugin into
  // $CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>. Nothing else
  // changes - not config.toml, not anything under HOME - and all three path
  // components are ACC's own. Verified on 0.147.0 by diffing the home around
  // the command, and by running a real session against a cache ACC wrote:
  // all five hooks fired.
  const cached = path.join(context.codexHome, "plugins", "cache", "acc-local",
    "agents-can-communicate", await pluginVersion(CODEX_PLUGIN));
  assert.deepEqual((await readdir(cached)).sort(),
    [".codex-plugin", "acc-hook.sh", "hooks.json", "skills"].sort());
});

test("the cached copy carries the same absolute hook command", async t => {
  const { context } = await realFixture(t);

  await createCodexAdapter().install(context);

  // The client runs the cached copy, not the published one. A command relative
  // to the bundle would not survive the copy; an absolute one does, which is
  // the whole reason the shim is written with absolute paths.
  const cached = JSON.parse(await readFile(path.join(context.codexHome, "plugins",
    "cache", "acc-local", "agents-can-communicate", await pluginVersion(CODEX_PLUGIN),
  "hooks.json"), "utf8"));
  const command = Object.values(cached.hooks)[0][0].hooks[0].command;
  const executable = command.match(/"([^"]+)"/)[1];
  assert.equal(path.isAbsolute(executable), true, `relative command: ${command}`);
});

test("detect reports the plugin as installed straight after install", async t => {
  const { context } = await realFixture(t);
  const adapter = createCodexAdapter();

  await adapter.install(context);

  // No remaining manual step to name.
  const said = (await adapter.detect(context)).diagnostics.join(" ");
  assert.match(said, /plugin installed in the client's cache/);
  assert.doesNotMatch(said, /codex plugin add/);
});

test("uninstall removes the cached copy too", async t => {
  const { context } = await realFixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  await adapter.uninstall(context);

  await assert.rejects(readdir(path.join(context.codexHome, "plugins", "cache",
    "acc-local")), error => error.code === "ENOENT");
});

test("context injection is declared, because it was finally observed", () => {
  const { capabilities } = createCodexAdapter();

  // Previously false with the honest reason "never seen reaching the model".
  // It has now been seen: a UserPromptSubmit hook's stdout arrives as a
  // `developer` role message in the request to the model, unwrapped. Verified
  // on 0.147.0 against a local stand-in endpoint that records the wire.
  assert.equal(capabilities.context.beforeTurnInjection, true);
});

test("injection is plain text, because this client wraps nothing", () => {
  // No envelope of any kind: whatever the hook prints becomes the message.
  // Emitting Claude Code's JSON envelope here would put the envelope itself
  // into the conversation, exactly as it would on Kimi Code.
  assert.deepEqual(injectOutcome("2 peers"),
    { stdout: "2 peers\n", stderr: "", exitCode: 0 });
  assert.deepEqual(injectOutcome(""), { stdout: "", stderr: "", exitCode: 0 });
});

/**
 * The name in the manifest, and the cache it is not allowed to own.
 *
 * This client discovers a marketplace at the agents home without any config
 * entry at all, and forms plugin ids and cache paths from whatever that
 * manifest calls itself. ACC used its own name for all three, so on a machine
 * that already had a marketplace here the id it enabled was one the client
 * never forms - `codex plugin list` said `not installed` while `acc install`
 * said it had worked. Measured against Codex 0.147.0.
 */
test("ACC registers a marketplace of its own, not the user's", async t => {
  const { context, theirs } = await fixture(t);
  await createCodexAdapter().install(context);

  const config = await readFile(path.join(context.codexHome, "config.toml"), "utf8");
  assert.match(config, /\[marketplaces\.acc-local\]/);
  assert.match(config, /\[plugins\."agents-can-communicate@acc-local"\]/);
  // The root it names is ACC's own, inside the agents home rather than at the
  // top of it: this client resolves a manifest entry against the root, so
  // joining the user's marketplace would put ACC's tree in `~/plugins/`.
  assert.match(config, /source = "[^"]*\/\.agents\/acc-local"/);

  // Which is the whole point: the marketplace this client discovers by itself
  // is the user's, named by its own manifest. ACC merged into it and then
  // enabled `…@acc-local`, an id this client never forms - so `acc install`
  // reported success and `codex plugin list` said `not installed`.
  assert.deepEqual(await theirs(), EXISTING);
});

test("uninstall removes ACC's own copy and nothing it did not put there", async t => {
  const { context } = await fixture(t);
  await createCodexAdapter().install(context);
  const root = path.join(context.codexHome, "plugins", "cache", "acc-local");
  // Something that is not ACC's, inside ACC's own cache directory. Neither the
  // plugin removal nor the empty-directory cleanup may reach it. This is the
  // shape of what actually happened on a real machine while ACC shared the
  // marketplace's cache root: it removed the root and took a plugin the user
  // had installed themselves.
  const theirs = path.join(root, "not-ours");
  await mkdir(theirs, { recursive: true });
  await writeFile(path.join(theirs, "marker"), "theirs\n");

  await createCodexAdapter().uninstall(context);

  assert.equal(await readFile(path.join(theirs, "marker"), "utf8"), "theirs\n",
    "uninstall reached past its own directory");
  await assert.rejects(readdir(path.join(root, "agents-can-communicate")),
    error => error.code === "ENOENT", "ACC left its own copy behind");
});

test("a marketplace ACC creates itself is still its own", async t => {
  // Nothing here before ACC: it writes the manifest, names it, and the id and
  // the cache follow that name.
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-fresh-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const context = { home, codexHome: path.join(home, ".codex") };

  await createCodexAdapter().install(context);

  const config = await readFile(path.join(context.codexHome, "config.toml"), "utf8");
  assert.match(config, /\[marketplaces\.acc-local\]/);
  assert.match(config, /\[plugins\."agents-can-communicate@acc-local"\]/);
  assert.deepEqual(await readdir(path.join(context.codexHome, "plugins", "cache",
    "acc-local")), ["agents-can-communicate"]);
});
