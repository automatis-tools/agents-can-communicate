import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, stat }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createGrokAdapter } from "../src/adapter.mjs";
import { allowResponse, denyResponse, injectResponse, normalizeGrokHook }
  from "../src/hooks.mjs";
import { hooksFile, shimPath, skillPath } from "../src/install.mjs";

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-grok-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const grokHome = path.join(home, ".grok");
  const claudeDir = path.join(home, ".claude");
  await mkdir(path.join(grokHome, "hooks"), { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(grokHome, "hooks", "other.json"),
    `${JSON.stringify({ hooks: { SessionStart: [] } }, null, 2)}\n`);
  await writeFile(path.join(claudeDir, "settings.json"),
    `${JSON.stringify({ theme: "dark", enabledPlugins: { "acc@acc-local": true } },
      null, 2)}\n`);
  const runner = path.join(home, "acc-hook.mjs");
  await writeFile(runner, "// stand-in for the runner\n");
  const claude = () => readFile(path.join(claudeDir, "settings.json"), "utf8");
  const foreign = () => readFile(path.join(grokHome, "hooks", "other.json"), "utf8");
  return { home, grokHome, claudeDir, claude, foreign,
    context: { home, grokHome, runner, node: "/usr/bin/node" } };
}

const captured = async name => JSON.parse(await readFile(
  new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

test("install writes only under .grok and leaves Claude Code alone", async t => {
  const { context, grokHome, claude, foreign } = await fixture(t);
  const beforeClaude = await claude();
  const beforeForeign = await foreign();

  await createGrokAdapter().install(context);

  assert.equal(await claude(), beforeClaude, "install touched ~/.claude");
  assert.equal(await foreign(), beforeForeign, "install rewrote a foreign hook file");
  await stat(hooksFile(grokHome));
  await stat(shimPath(grokHome));
  const skill = await readFile(path.join(skillPath(grokHome), "SKILL.md"), "utf8");
  assert.equal(skill.includes("{{ACC}}"), false, "skill still has the placeholder");
  assert.match(skill, /\/usr\/bin\/node/);
});

test("install is idempotent and uninstall restores the user's files", async t => {
  const { context, grokHome, home, claude, foreign } = await fixture(t);
  const adapter = createGrokAdapter();
  const beforeClaude = await claude();
  const beforeForeign = await foreign();

  await adapter.install(context);
  const firstHooks = await readFile(hooksFile(grokHome), "utf8");
  await adapter.install(context);
  assert.equal(await readFile(hooksFile(grokHome), "utf8"), firstHooks);

  await adapter.uninstall(context);
  await adapter.uninstall(context);

  await stat(path.join(grokHome, "hooks", "other.json"));
  await assert.rejects(stat(hooksFile(grokHome)), { code: "ENOENT" });
  await assert.rejects(stat(shimPath(grokHome)), { code: "ENOENT" });
  await assert.rejects(stat(skillPath(grokHome)), { code: "ENOENT" });
  assert.equal(await claude(), beforeClaude);
  assert.equal(await foreign(), beforeForeign);
  assert.deepEqual((await readdir(path.join(home, ".claude"))).sort(), ["settings.json"]);
});

test("the hook file points at the shim with this adapter id", async t => {
  const { context, grokHome } = await fixture(t);
  await createGrokAdapter().install(context);

  const wired = JSON.parse(await readFile(hooksFile(grokHome), "utf8"));
  const shim = await readFile(shimPath(grokHome), "utf8");
  assert.match(shim, /"\$ACC_RUNNER" grok "\$@"/);
  const matcher = wired.hooks.PreToolUse[0].matcher;
  assert.match(matcher, /write/);
  assert.match(matcher, /search_replace/);
  assert.match(matcher, /run_terminal_command/);
  assert.doesNotMatch(matcher, /Write\|Edit\|Bash/);
  assert.doesNotMatch(matcher, /apply_patch/);
  for (const entries of Object.values(wired.hooks)) {
    for (const hook of entries.flatMap(entry => entry.hooks)) {
      assert.equal(typeof hook.timeout, "number");
      assert.equal(hook.timeout > 0 && hook.timeout <= 120, true,
        `${hook.command} timeout ${hook.timeout} is not seconds`);
      assert.match(hook.command, /acc-hook\.sh/);
    }
  }
});

test("only capabilities observed on a real Grok session are declared true", () => {
  const { capabilities } = createGrokAdapter();

  assert.equal(capabilities.lifecycle.sessionStart, true);
  assert.equal(capabilities.lifecycle.sessionEnd, true);
  assert.equal(capabilities.delivery.polling, true);

  assert.equal(capabilities.context.beforeTurnInjection, false);
  assert.equal(capabilities.guards.beforeWrite, false);
  assert.equal(capabilities.guards.beforeShell, false);
  assert.equal(capabilities.lifecycle.heartbeat, false);
  assert.equal(capabilities.lifecycle.childSessions, false);
  for (const value of Object.values(capabilities.execution)) assert.equal(value, false);
});

test("captured payloads normalise and drop conversation content", async () => {
  const kinds = { SessionStart: "sessionStart", UserPromptSubmit: "beforeTurn",
    "PreToolUse-write": "beforeTool", Stop: "turnEnd", SessionEnd: "sessionEnd" };

  for (const [name, kind] of Object.entries(kinds)) {
    const payload = await captured(name);
    const normalised = normalizeGrokHook(payload);

    assert.equal(normalised.kind, kind, `${name} normalised wrongly`);
    assert.equal(normalised.sessionId, payload.sessionId);
    assert.deepEqual(Object.keys(normalised).sort(),
      ["cwd", "kind", "model", "parentSessionId", "sessionId", "targets", "tool"]);
    assert.equal(JSON.stringify(normalised).includes("redacted"), false,
      `${name} carried conversation content through`);
  }
});

test("the guard sees this client's real tool names", async () => {
  const write = normalizeGrokHook(await captured("PreToolUse-write"));
  const edit = normalizeGrokHook(await captured("PreToolUse-search_replace"));
  const shell = normalizeGrokHook(await captured("PreToolUse-run_terminal_command"));
  const wired = JSON.parse(await readFile(new URL(
    "../plugin/hooks/hooks.json", import.meta.url), "utf8"));
  const matcher = wired.hooks.PreToolUse[0].matcher;

  for (const event of [write, edit, shell]) {
    assert.equal(matcher.split("|").includes(event.tool), true,
      `the captured tool ${event.tool} is not covered by ${matcher}`);
  }
  assert.deepEqual([...write.targets], ["/tmp/example-workspace/notes.txt"]);
  assert.deepEqual([...edit.targets], ["/tmp/example-workspace/notes.txt"]);
  assert.deepEqual([...shell.targets], ["/tmp/example-workspace/notes.txt"]);
});

test("reading a file is not a write", () => {
  const normalised = normalizeGrokHook({ hookEventName: "pre_tool_use",
    sessionId: "s", cwd: "/tmp", toolName: "read_file",
    toolInput: { file_path: "/tmp/notes.txt" } });

  assert.deepEqual([...normalised.targets], []);
});

test("Claude tool names do not silently become writes", () => {
  const normalised = normalizeGrokHook({ hookEventName: "pre_tool_use",
    sessionId: "s", cwd: "/tmp", toolName: "Write",
    toolInput: { file_path: "/tmp/notes.txt" } });

  assert.deepEqual([...normalised.targets], []);
});

test("a deny response uses this client's documented native shape", () => {
  const denied = denyResponse("held by another session");

  assert.deepEqual(denied, { decision: "deny", reason: "held by another session" });
  assert.deepEqual(allowResponse(), {});
});

test("injected context is emitted only when there is something to say", () => {
  assert.deepEqual(injectResponse(""), {});
  assert.deepEqual(injectResponse("2 peers"), { hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: "2 peers" } });
});

test("an unrecognised event or a payload without identity is refused", () => {
  assert.throws(() => normalizeGrokHook({ hookEventName: "Imaginary",
    sessionId: "s", cwd: "/tmp" }), error => error.code === EXIT.DATA);
  assert.throws(() => normalizeGrokHook({ hookEventName: "session_start" }),
    error => error.code === EXIT.DATA);
});

test("planInstall never names ~/.claude", () => {
  const home = "/home/dana";
  const artifacts = createGrokAdapter().planInstall({ home,
    grokHome: path.join(home, ".grok") });

  for (const artifact of artifacts) {
    assert.equal(artifact.path.includes(".claude"), false, artifact.path);
    assert.equal(artifact.path.startsWith(`${home}/.grok/`), true, artifact.path);
  }
});

test("doctor names the independence from Claude Code", async t => {
  const { context } = await fixture(t);
  const report = await createGrokAdapter().doctor(context);

  assert.match(report.diagnostics.join("\n"), /Claude Code is a separate adapter/);
  assert.match(report.diagnostics.join("\n"), /acc hooks not registered/);
});
