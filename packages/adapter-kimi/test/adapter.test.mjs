import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createKimiAdapter } from "../src/adapter.mjs";
import { allowResponse, denyResponse, injectResponse, normalizeKimiHook }
  from "../src/hooks.mjs";
import { BEGIN, END, renderBlock, stripBlock } from "../src/install.mjs";

// A config the user owns: comments, formatting, their own hook, and a table at
// the very end - the position where an appended block is most likely to be
// swallowed by the preceding section.
const EXISTING = `# my settings
default_model = "kimi-code/k3"

[[hooks]]
event = "SessionStart"
command = "my-own-hook"
timeout = 5

[providers."managed:kimi-code"]
type = "kimi"
`;

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-kimi-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "config.toml"), EXISTING);
  // A real runner file, because install refuses to wire one that is not there.
  const runner = path.join(home, "acc-hook.mjs");
  await writeFile(runner, "// stand-in for the runner\n");
  const read = () => readFile(path.join(home, "config.toml"), "utf8");
  return { context: { home, runner, node: "/usr/bin/node" }, read };
}

const captured = async name => JSON.parse(await readFile(
  new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

test("install adds ACC's block and leaves the rest of the config byte for byte", async t => {
  const { context, read } = await fixture(t);

  await createKimiAdapter().install(context);

  const config = await read();
  assert.equal(config.startsWith(EXISTING), true,
    "install rewrote the part of the config it does not own");
  assert.match(config, /# >>> agents-can-communicate/);
  assert.match(config, /event = "SessionHeartbeat"/);
});

test("install is idempotent and uninstall restores the config exactly", async t => {
  const { context, read } = await fixture(t);
  const adapter = createKimiAdapter();

  await adapter.install(context);
  const afterFirst = await read();
  await adapter.install(context);
  assert.equal(await read(), afterFirst, "a second install duplicated the block");

  await adapter.uninstall(context);
  assert.equal(await read(), EXISTING, "uninstall did not restore the config");
  await adapter.uninstall(context);
  assert.equal(await read(), EXISTING);
});

test("uninstall keeps the user's own hook, which looks just like one of ours", async t => {
  const { context, read } = await fixture(t);
  const adapter = createKimiAdapter();
  await adapter.install(context);

  await adapter.uninstall(context);

  // Ownership is the delimited region, not the shape of an entry. Removing
  // every [[hooks]] entry would have taken theirs too.
  assert.match(await read(), /command = "my-own-hook"/);
});

test("a half-deleted marker cannot leave stray entries behind", () => {
  // If a user removes the end marker by hand, stripping to end of file is the
  // safe reading: leaving orphaned [[hooks]] entries would fail this client's
  // schema and lock them out of their own tool.
  const damaged = `keep = true\n${BEGIN}\n[[hooks]]\nevent = "Stop"\n`;

  assert.equal(stripBlock(damaged).includes("[[hooks]]"), false);
  assert.match(stripBlock(damaged), /keep = true/);
  assert.equal(stripBlock(`a = 1\n${BEGIN}\nx\n${END}\nb = 2\n`), "a = 1\nb = 2\n");
});

// Decode a TOML basic string the way the client's parser will, so the test
// checks the command that actually reaches the shell rather than the escape
// sequences on the way there.
const decodeToml = line => line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'))
  .replace(/\\(["\\])/g, "$1");

test("paths with quotes or spaces survive into the command the shell runs", () => {
  const runner = '/opt/my "acc" dir/acc-hook.mjs';
  const node = "/usr/local/my node/bin/node";

  const block = renderBlock(runner, node);

  const command = decodeToml(block.split("\n").find(line => line.startsWith("command")));
  // Two layers: escaped for TOML, then quoted for the shell. An unescaped quote
  // would break the config for every hook at once, and an unquoted space would
  // split the path into arguments.
  assert.equal(command, `"${node}" "/opt/my \\"acc\\" dir/acc-hook.mjs" kimi sessionStart`);
  assert.equal(block.split("[[hooks]]").length - 1, 5);
});

test("hook entries carry a timeout in the unit this client uses", () => {
  const block = renderBlock("/opt/acc/bin/acc-hook.mjs", "/usr/bin/node");

  // Seconds. A hook that sleeps 3s dies under `timeout = 1`, which is how this
  // was settled - another harness's 10000 would be nearly three hours here.
  for (const line of block.split("\n").filter(l => l.startsWith("timeout"))) {
    const value = Number(line.split("=")[1].trim());
    assert.equal(Number.isInteger(value) && value > 0 && value <= 120, true,
      `${line} is not a plausible timeout in seconds`);
  }
});

test("the guard matcher names the tools this client actually uses", () => {
  const block = renderBlock("/opt/acc/bin/acc-hook.mjs", "/usr/bin/node");
  const matcher = block.split("\n").find(line => line.startsWith("matcher"));

  // Read out of a real request. "NoSuchTool" was observed never firing while
  // "Write|Edit|Bash" fired twice in the same turn, so the matcher is applied
  // and this pattern is the one that matches.
  assert.match(matcher, /Write/);
  assert.match(matcher, /Bash/);
  assert.doesNotMatch(matcher, /apply_patch/);
});

test("the plugin bundle carries a Kimi manifest and the coordination skill", async t => {
  const { context } = await fixture(t);
  await createKimiAdapter().install(context);
  const target = path.join(context.home, "plugins", "managed", "agents-can-communicate");

  assert.deepEqual((await readdir(target)).sort(), [".kimi-plugin", "skills"]);
  const manifest = JSON.parse(await readFile(
    path.join(target, ".kimi-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.sessionStart.skill, "acc");

  const registry = JSON.parse(await readFile(
    path.join(context.home, "plugins", "installed.json"), "utf8"));
  assert.equal(registry.plugins.some(entry => entry.id === "agents-can-communicate"), true);
});

test("only capabilities observed firing are declared true", () => {
  const { capabilities } = createKimiAdapter();

  assert.equal(capabilities.lifecycle.sessionStart, true);
  assert.equal(capabilities.lifecycle.heartbeat, true);
  assert.equal(capabilities.context.beforeTurnInjection, true);
  assert.equal(capabilities.guards.beforeWrite, true);
  assert.equal(capabilities.guards.beforeShell, true);

  // In the event enum, wired in every capture run, never once fired.
  assert.equal(capabilities.lifecycle.sessionEnd, false);
  assert.equal(capabilities.lifecycle.childSessions, false);
  assert.equal(capabilities.guards.beforeRead, false);
  for (const value of Object.values(capabilities.execution)) assert.equal(value, false);
});

test("captured payloads normalise and drop conversation content", async () => {
  const kinds = { SessionStart: "sessionStart", UserPromptSubmit: "beforeTurn",
    TurnStarted: "other", SessionHeartbeat: "heartbeat", Stop: "turnEnd",
    StopFailure: "turnEnd", "PreToolUse-Write": "beforeTool", "PreToolUse-Bash": "beforeTool",
    "PostToolUse-Write": "afterTool", "PostToolUseFailure-Bash": "afterTool" };

  for (const [name, kind] of Object.entries(kinds)) {
    const payload = await captured(name);
    const normalised = normalizeKimiHook(payload);

    assert.equal(normalised.kind, kind, `${name} normalised wrongly`);
    assert.equal(normalised.sessionId, payload.session_id);
    assert.deepEqual(Object.keys(normalised).sort(),
      ["cwd", "kind", "model", "parentSessionId", "sessionId", "tool"]);
    // The prompt, the tool output, the written file's contents and the error
    // text are all handed to hooks by this client. None may survive.
    assert.equal(JSON.stringify(normalised).includes("redacted"), false,
      `${name} carried conversation content through`);
  }
});

test("the guard sees the real tool name on both a write and a shell call", async () => {
  assert.equal(normalizeKimiHook(await captured("PreToolUse-Write")).tool, "Write");
  assert.equal(normalizeKimiHook(await captured("PreToolUse-Bash")).tool, "Bash");
});

test("the model is read only from the event that carries it", async () => {
  assert.equal(normalizeKimiHook(await captured("SessionStart")).model, "kimi-code/k3");
  // Carrying a model forward from an earlier event would be an invention.
  assert.equal(normalizeKimiHook(await captured("Stop")).model, null);
});

test("a deny uses the one shape this client acts on", () => {
  const denied = denyResponse("held by another session");

  // Of five candidates run against a real session, only this and exit code 2
  // stopped the tool. {"decision":"block"} and {"permission":"deny"} both looked
  // right and let the write through.
  assert.deepEqual(denied, { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "held by another session" } });
  assert.deepEqual(allowResponse(), {});
});

test("injection is plain text, because this client does not unwrap an envelope", () => {
  // Observed: whatever a hook prints is shown to the model inside
  // <hook_result hook_event="...">. Emitting Claude Code's JSON envelope here
  // put the envelope itself into the conversation.
  assert.equal(injectResponse("2 peers"), "2 peers");
  assert.equal(injectResponse(""), null, "solo injected an empty banner");
});

test("an unrecognised event or a payload without identity is refused", () => {
  assert.throws(() => normalizeKimiHook({ hook_event_name: "Imaginary",
    session_id: "s", cwd: "/tmp" }), error => error.code === EXIT.DATA);
  assert.throws(() => normalizeKimiHook({ hook_event_name: "SessionStart" }),
    error => error.code === EXIT.DATA);
});

test("doctor names the heartbeat and the missing session end", async t => {
  const { context } = await fixture(t);
  const adapter = createKimiAdapter();
  await adapter.install(context);

  const report = await adapter.doctor(context);
  const said = report.diagnostics.join(" ");

  assert.match(said, /60s/);
  assert.match(said, /never observed firing/);
  assert.match(said, /seconds, not milliseconds/);
});

test("detect is read-only and reports registration honestly", async t => {
  const { context, read } = await fixture(t);
  const adapter = createKimiAdapter();

  const before = await adapter.detect(context);
  assert.match(before.diagnostics.join(" "), /not registered/);
  assert.equal(await read(), EXISTING, "detect changed the config");

  await adapter.install(context);
  assert.match((await adapter.detect(context)).diagnostics.join(" "),
    /hooks registered in config\.toml/);
});

test("uninstall on a config that was never installed into changes nothing", async t => {
  const { context, read } = await fixture(t);

  const result = await createKimiAdapter().uninstall(context);

  assert.equal(await read(), EXISTING);
  assert.deepEqual(result.changes, []);
});

test("install refuses to wire a runner that is not there", async t => {
  const { context, read } = await fixture(t);

  // The three earlier adapters all wire a command named `acc-hook`, and no such
  // program exists in this repository. A hook whose command is missing fails
  // silently, on every event, for as long as it stays installed - the client
  // reports nothing and ACC sees no sessions. Refusing to write the entry is the
  // only way that failure is ever noticed.
  await assert.rejects(
    createKimiAdapter().install({ ...context, runner: "/nonexistent/acc-hook.mjs" }),
    error => error.code === EXIT.DATA && /runner/.test(error.message));

  assert.equal(await read(), EXISTING, "a refused install still edited the config");
});

test("doctor says whether the wired runner can actually be executed", async t => {
  const { context } = await fixture(t);
  const adapter = createKimiAdapter();
  await adapter.install(context);

  assert.match((await adapter.doctor(context)).diagnostics.join(" "), /runner/);
});

test("the end marker is what closes the block", () => {
  assert.equal(stripBlock(`${BEGIN}\nx = 1\n${END}\n`), "");
  // A second block, from an older install, goes too.
  assert.equal(stripBlock(`a = 1\n${BEGIN}\nx\n${END}\n${BEGIN}\ny\n${END}\nb = 2\n`),
    "a = 1\nb = 2\n");
});
