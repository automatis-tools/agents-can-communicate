import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCodexAdapter } from "../src/adapter.mjs";
import { CODEX_HOOK_EVENTS, normalizeCodexHook } from "../src/hooks.mjs";

// A marketplace the user already owns, with an unrelated plugin in it.
const EXISTING = { name: "personal", plugins: {
  "someone-elses-plugin": { source: "./plugins/someone-elses-plugin" } } };

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const marketplace = path.join(home, ".agents", "plugins", "marketplace.json");
  await mkdir(path.dirname(marketplace), { recursive: true });
  await writeFile(marketplace, `${JSON.stringify(EXISTING, null, 2)}\n`);
  const read = async () => JSON.parse(await readFile(marketplace, "utf8"));
  return { context: { home }, marketplace, read };
}

test("install places the plugin and registers it in the marketplace", async t => {
  const { context, read } = await fixture(t);

  const result = await createCodexAdapter().install(context);

  assert.equal(result.ok, true);
  const plugin = path.join(context.home, "plugins", "agents-can-communicate");
  assert.deepEqual((await readdir(plugin)).sort(),
    [".codex-plugin", "acc-hook.sh", "hooks.json", "skills"].sort());
  const manifest = JSON.parse(await readFile(
    path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.hooks, "./hooks.json");
  assert.equal((await read()).plugins["agents-can-communicate"] !== undefined, true);
});

test("install is idempotent and leaves the user's own plugin alone", async t => {
  const { context, read } = await fixture(t);
  const adapter = createCodexAdapter();

  await adapter.install(context);
  const afterFirst = await read();
  await adapter.install(context);

  assert.deepEqual(await read(), afterFirst, "a second install changed the marketplace");
  assert.deepEqual(afterFirst.plugins["someone-elses-plugin"],
    EXISTING.plugins["someone-elses-plugin"]);
  assert.equal(afterFirst.name, "personal");
});

test("uninstall removes only what ACC owns, twice safely", async t => {
  const { context, read } = await fixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  await adapter.uninstall(context);
  const afterFirst = await read();
  await adapter.uninstall(context);

  assert.deepEqual(afterFirst.plugins, EXISTING.plugins,
    "uninstall did not restore the marketplace");
  assert.deepEqual(await read(), afterFirst);
  await assert.rejects(readdir(path.join(context.home, "plugins", "agents-can-communicate")),
    error => error.code === "ENOENT");
});

test("the hooks file wires only events this client actually has", async t => {
  const { context } = await fixture(t);
  await createCodexAdapter().install(context);

  const wired = JSON.parse(await readFile(path.join(context.home, "plugins",
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
  const { context, read } = await fixture(t);
  const adapter = createCodexAdapter();

  const before = await adapter.detect(context);
  assert.match(before.diagnostics.join(" "), /not registered/);

  await adapter.install(context);
  const after = await adapter.detect(context);

  assert.match(after.diagnostics.join(" "), /registered/);
  assert.equal((await read()).plugins["someone-elses-plugin"] !== undefined, true);
});

test("only capabilities observed in a real session are declared true", () => {
  const { capabilities } = createCodexAdapter();

  // Observed firing on codex-cli 0.147.0; fixtures are in fixtures/.
  assert.equal(capabilities.lifecycle.sessionStart, true);
  assert.equal(capabilities.lifecycle.sessionEnd, true);
  assert.equal(capabilities.guards.beforeWrite, true);
  assert.equal(capabilities.guards.beforeShell, true);

  // Not observed, so not claimed. Injection was never seen reaching the model,
  // and no subagent ran during the capture.
  assert.equal(capabilities.context.beforeTurnInjection, false);
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
  const wired = JSON.parse(await readFile(path.join(context.home, "plugins",
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
