import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
  assert.deepEqual(await readdir(path.join(context.configDir, "plugins",
    "agents-can-communicate")), [".claude-plugin", "hooks", "skills"].sort());
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
  assert.equal(capabilities.delivery.wakeDormantSession, false);
  for (const value of Object.values(capabilities.execution)) assert.equal(value, false);
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
      ["cwd", "kind", "model", "parentSessionId", "sessionId", "tool"]);
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
});
