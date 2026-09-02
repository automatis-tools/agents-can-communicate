import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CLAUDE_PLUGIN, pluginVersion } from "../../../tests/helpers/plugin-version.mjs";

import { EXIT } from "@agents-can-communicate/protocol";

import { createClaudeCodeAdapter } from "../src/adapter.mjs";
import { allowResponse, denyResponse, injectResponse, normalizeClaudeHook }
  from "../src/hooks.mjs";

// Settings the user already owns, including a hook of their own that looks a
// lot like one of ours.
const EXISTING = {
  theme: "dark",
  hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command",
    command: "their-own-guard" }] }] },
};

async function fixture(t) {
  const configDir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cc-")));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await writeFile(path.join(configDir, "settings.json"),
    `${JSON.stringify(EXISTING, null, 2)}\n`);
  const read = async () => JSON.parse(await readFile(
    path.join(configDir, "settings.json"), "utf8"));
  return { context: { configDir }, read };
}

const captured = async name => JSON.parse(await readFile(
  new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

test("install registers the plugin and preserves the user's own hook", async t => {
  const { context, read } = await fixture(t);

  await createClaudeCodeAdapter().install(context);

  const settings = await read();
  assert.deepEqual(settings.hooks, EXISTING.hooks, "install disturbed a foreign hook");
  assert.equal(settings.theme, "dark");
  // Two trees, both needed: the marketplace the client reads the manifest from,
  // and the cache copy it actually runs.
  assert.deepEqual(await readdir(path.join(context.configDir, "plugins",
    "marketplaces", "acc-local", "agents-can-communicate")),
  [".claude-plugin", "hooks", "skills"].sort());
  assert.deepEqual(await readdir(path.join(context.configDir, "plugins", "cache",
    "acc-local", "agents-can-communicate", await pluginVersion(CLAUDE_PLUGIN))),
  [".claude-plugin", "hooks", "skills"].sort());

  // Registered the way the client registers plugins, measured from its own
  // commands. `accPlugins` was ACC's invention and loaded nothing.
  assert.equal(settings.enabledPlugins["agents-can-communicate@acc-local"], true);
  assert.equal(settings.extraKnownMarketplaces["acc-local"].source.source, "directory");
  const installed = JSON.parse(await readFile(path.join(context.configDir, "plugins",
    "installed_plugins.json"), "utf8"));
  assert.equal(installed.version, 2);
  assert.equal(installed.plugins["agents-can-communicate@acc-local"][0].scope, "user");
});

test("a user's own enabled plugins survive install and uninstall", async t => {
  // `enabledPlugins` holds every plugin the user has. Taking the whole key would
  // destroy them, and handing it back on uninstall would destroy them again -
  // this machine had twenty-three entries in it.
  const { context, read } = await fixture(t);
  const mine = { "superpowers@claude-plugins-official": true,
    "github@claude-plugins-official": false };
  const file = path.join(context.configDir, "settings.json");
  await writeFile(file, `${JSON.stringify({ ...EXISTING, enabledPlugins: mine,
    extraKnownMarketplaces: { thedotmack: { source: { source: "github" } } } },
  null, 2)}\n`);
  const adapter = createClaudeCodeAdapter();

  await adapter.install(context);
  const after = await read();
  assert.equal(after.enabledPlugins["superpowers@claude-plugins-official"], true);
  assert.equal(after.enabledPlugins["github@claude-plugins-official"], false);
  assert.equal(after.enabledPlugins["agents-can-communicate@acc-local"], true);

  await adapter.uninstall(context);
  const restored = await read();
  assert.deepEqual(restored.enabledPlugins, mine, "a user's plugins were disturbed");
  assert.deepEqual(restored.extraKnownMarketplaces,
    { thedotmack: { source: { source: "github" } } });
});

test("install is idempotent and uninstall restores exactly", async t => {
  const { context, read } = await fixture(t);
  const adapter = createClaudeCodeAdapter();

  await adapter.install(context);
  const afterFirst = await read();
  await adapter.install(context);
  assert.deepEqual(await read(), afterFirst);

  await adapter.uninstall(context);
  const restored = await read();
  await adapter.uninstall(context);

  assert.deepEqual(restored, EXISTING, "uninstall did not restore the settings");
  assert.deepEqual(await read(), restored);
});

test("only capabilities observed in a real session are declared true", () => {
  const { capabilities } = createClaudeCodeAdapter();

  assert.equal(capabilities.lifecycle.sessionStart, true);
  assert.equal(capabilities.lifecycle.sessionEnd, true);
  assert.equal(capabilities.context.beforeTurnInjection, true);
  assert.equal(capabilities.guards.beforeWrite, true);
  assert.equal(capabilities.guards.beforeShell, true);

  // Documented and real, but no subagent ran during the capture.
  assert.equal(capabilities.lifecycle.childSessions, false);
  assert.equal(capabilities.context.startupInjection, false);
  assert.equal(capabilities.delivery.nextTurn, true);
  assert.equal(capabilities.delivery.livePush, false);
  assert.equal(capabilities.delivery.replyRoute, false);
});

test("captured payloads normalise and drop conversation content", async () => {
  const kinds = { SessionStart: "sessionStart", UserPromptSubmit: "beforeTurn",
    PreToolUse: "beforeTool", PostToolUse: "afterTool", Stop: "turnEnd",
    SessionEnd: "sessionEnd" };

  for (const [event, kind] of Object.entries(kinds)) {
    const payload = await captured(event);
    const normalised = normalizeClaudeHook(payload);

    assert.equal(normalised.kind, kind, `${event} normalised wrongly`);
    assert.equal(normalised.sessionId, payload.session_id);
    assert.deepEqual(Object.keys(normalised).sort(),
      ["cwd", "kind", "model", "parentSessionId", "sessionId", "targets", "tool"]);
    // Every payload carries a transcript path, and some carry the prompt or the
    // model's last message. None of it may survive normalisation.
    assert.equal(JSON.stringify(normalised).includes("redacted"), false,
      `${event} carried conversation content through`);
  }
});

test("the guard sees this client's real tool names", async () => {
  const guarded = normalizeClaudeHook(await captured("PreToolUse"));
  const wired = JSON.parse(await readFile(new URL(
    "../plugin/hooks/hooks.json", import.meta.url), "utf8"));
  const matcher = wired.hooks.PreToolUse[0].matcher;

  // Both Write and Bash were observed being denied on 2.1.233; the surviving
  // fixture is the Bash one. What matters is that the matcher names the tools
  // this client actually uses - Codex names its editor apply_patch, and a
  // matcher borrowed across harnesses silently guards nothing.
  assert.equal(matcher.split("|").includes(guarded.tool), true,
    `the captured tool ${guarded.tool} is not covered by ${matcher}`);
  assert.match(matcher, /Write/);
  assert.match(matcher, /Bash/);
  assert.doesNotMatch(matcher, /apply_patch/);
});

test("an edit declares the path it would write, and so does a shell write", async () => {
  // Captured from 2.1.233: Write takes file_path/content, Edit takes file_path
  // with old_string/new_string. Without the path a guard has nothing to compare
  // against a claim.
  const edit = normalizeClaudeHook(await captured("PreToolUse-Edit"));
  assert.equal(edit.tool, "Edit");
  assert.deepEqual([...edit.targets], ["/tmp/example-workspace/notes.txt"]);

  // The surviving PreToolUse fixture is the Bash one, and `echo probe` writes
  // nothing. A command that does write is a different matter: this session is
  // itself told to prefer the shell for file changes, which is precisely why
  // the command is read rather than waved through.
  assert.deepEqual([...normalizeClaudeHook(await captured("PreToolUse")).targets], []);

  const shell = normalizeClaudeHook({ hook_event_name: "PreToolUse", session_id: "s",
    cwd: "/tmp", tool_name: "Bash",
    tool_input: { command: "printf '// x' >> /tmp/example-workspace/notes.txt" } });
  assert.deepEqual([...shell.targets], ["/tmp/example-workspace/notes.txt"]);
});

test("reading a file is not a write", () => {
  // Read takes file_path too. Treating it as a target would have sessions
  // blocking each other for looking at things.
  const normalised = normalizeClaudeHook({ hook_event_name: "PreToolUse",
    session_id: "s", cwd: "/tmp", tool_name: "Read",
    tool_input: { file_path: "/tmp/notes.txt" } });

  assert.deepEqual([...normalised.targets], []);
});

test("the file's contents never reach the event, only its path", async () => {
  const payload = await captured("PreToolUse-Edit");
  assert.equal(JSON.stringify(payload.tool_input).includes("redacted"), true);

  assert.equal(JSON.stringify(normalizeClaudeHook(payload)).includes("redacted"), false);
});

test("a deny response uses this client's exact structured shape", () => {
  const denied = denyResponse("held by another session");

  // Observed working: this exact shape stopped a Write and a Bash call.
  assert.deepEqual(denied, { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "held by another session" } });
  assert.deepEqual(allowResponse(), {});
});

test("injected context is emitted only when there is something to say", () => {
  assert.deepEqual(injectResponse(""), {}, "solo injected an empty banner");
  assert.deepEqual(injectResponse("2 peers"), { hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: "2 peers" } });
});

test("an unrecognised event or a payload without identity is refused", () => {
  assert.throws(() => normalizeClaudeHook({ hook_event_name: "Imaginary",
    session_id: "s", cwd: "/tmp" }), error => error.code === EXIT.DATA);
  assert.throws(() => normalizeClaudeHook({ hook_event_name: "SessionStart" }),
    error => error.code === EXIT.DATA);
});

test("doctor states that the handoff is not written at SessionEnd", async t => {
  const { context } = await fixture(t);
  const adapter = createClaudeCodeAdapter();
  await adapter.install(context);

  const report = await adapter.doctor(context);

  // SessionEnd is advisory and fires after the model has stopped, so it cannot
  // summarise anything. Saying so in doctor keeps the limitation visible.
  assert.match(report.diagnostics.join(" "), /while the model is active/);
  assert.match(report.diagnostics.join(" "), /captured/);
  assert.match(report.diagnostics.join(" "), /2\.1\.252/,
    "doctor hid which native-delivery capture failed");
  assert.match(report.diagnostics.join(" "), /development-channel security warning/,
    "doctor hid the client boundary that prevented native delivery");
  assert.match(report.diagnostics.join(" "), /next-turn.*acc inbox/,
    "doctor did not name the durable fallback");
});

test("the client's own registries come back byte for byte", async t => {
  // The client writes these with no trailing newline. ACC added one, so the
  // content restored exactly and the bytes did not - which is the promise this
  // tool makes about files it only borrowed.
  const { context } = await fixture(t);
  const registries = ["known_marketplaces.json", "installed_plugins.json"]
    .map(name => path.join(context.configDir, "plugins", name));
  const original = { version: 2, plugins: { "someone@else": [{ scope: "user" }] } };
  await mkdir(path.dirname(registries[0]), { recursive: true });
  await writeFile(registries[0], JSON.stringify({ theirs: { source: {} } }, null, 2));
  await writeFile(registries[1], JSON.stringify(original, null, 2));
  const before = await Promise.all(registries.map(file => readFile(file, "utf8")));

  const adapter = createClaudeCodeAdapter();
  await adapter.install(context);
  await adapter.uninstall(context);

  const after = await Promise.all(registries.map(file => readFile(file, "utf8")));
  assert.deepEqual(after, before, "a borrowed registry came back changed");
});
