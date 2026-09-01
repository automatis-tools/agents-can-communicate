import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createGeminiCliAdapter } from "../src/adapter.mjs";
import { allowResponse, denyResponse, injectResponse, normalizeGeminiHook }
  from "../src/hooks.mjs";

// The user already has a hook of their own on an event ACC also uses, with a
// command string that is easy to confuse for ours.
const THEIRS = { name: "claude-mem", type: "command", command: "acc-hook beforeTurn",
  timeout: 5000 };
const EXISTING = { theme: "dark", hooks: {
  BeforeAgent: [{ matcher: "*", hooks: [THEIRS] }] } };

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-gemini-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".gemini"), { recursive: true });
  await writeFile(path.join(home, ".gemini", "settings.json"),
    `${JSON.stringify(EXISTING, null, 2)}\n`);
  const read = async () => JSON.parse(await readFile(
    path.join(home, ".gemini", "settings.json"), "utf8"));
  return { context: { home }, read };
}

const captured = async name => JSON.parse(await readFile(
  new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

test("install adds ACC hooks beside the user's own on the same event", async t => {
  const { context, read } = await fixture(t);

  await createGeminiCliAdapter().install(context);

  const settings = await read();
  const beforeAgent = settings.hooks.BeforeAgent.flatMap(entry => entry.hooks);
  assert.equal(beforeAgent.some(hook => hook.name === "claude-mem"), true,
    "install removed the user's own hook from a shared event");
  assert.equal(beforeAgent.some(hook => hook.name === "acc-beforeTurn"), true);
  assert.equal(settings.theme, "dark");
});

test("uninstall removes ours by name and leaves an identical command alone", async t => {
  const { context, read } = await fixture(t);
  const adapter = createGeminiCliAdapter();
  await adapter.install(context);

  await adapter.uninstall(context);

  // Their hook carries the same command string as ours. Removing by command
  // would have taken it; ownership is by the `name` field this client supports.
  assert.deepEqual(await read(), EXISTING, "uninstall did not restore the settings exactly");
});

test("install and uninstall are both idempotent", async t => {
  const { context, read } = await fixture(t);
  const adapter = createGeminiCliAdapter();

  await adapter.install(context);
  const afterFirst = await read();
  await adapter.install(context);
  assert.deepEqual(await read(), afterFirst, "a second install duplicated entries");

  await adapter.uninstall(context);
  const restored = await read();
  await adapter.uninstall(context);
  assert.deepEqual(await read(), restored);
});

test("the extension bundle carries a manifest and the coordination skill", async t => {
  const { context } = await fixture(t);
  await createGeminiCliAdapter().install(context);
  const target = path.join(context.home, ".gemini", "extensions", "agents-can-communicate");

  assert.deepEqual((await readdir(target)).sort(),
    ["gemini-extension.json", "hooks", "skills"]);
  const manifest = JSON.parse(await readFile(
    path.join(target, "gemini-extension.json"), "utf8"));
  assert.equal(manifest.name, "agents-can-communicate");
  assert.equal(manifest.contextFileName, "skills/acc/SKILL.md");
});

test("hook entries carry the name and timeout this client supports", async t => {
  const { context } = await fixture(t);
  await createGeminiCliAdapter().install(context);
  const settings = JSON.parse(await readFile(
    path.join(context.home, ".gemini", "settings.json"), "utf8"));

  for (const entries of Object.values(settings.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks.filter(item => item.name?.startsWith("acc-"))) {
        assert.equal(typeof hook.name, "string");
        // A hook without a bound timeout can hang a turn.
        assert.equal(Number.isInteger(hook.timeout) && hook.timeout > 0, true,
          `${hook.name} has no timeout`);
        assert.equal(hook.type, "command");
      }
    }
  }
});

test("no environment variable or secret is copied into settings", async t => {
  const { context, read } = await fixture(t);
  await createGeminiCliAdapter().install(context);

  const serialised = JSON.stringify(await read());

  assert.equal(/GEMINI_API_KEY|GOOGLE_API_KEY|oauth|credential|token/i.test(serialised), false,
    "installation persisted something that looks like a secret");
});

test("only capabilities observed firing are declared true", () => {
  const { capabilities } = createGeminiCliAdapter();

  assert.equal(capabilities.lifecycle.sessionStart, true);
  assert.equal(capabilities.lifecycle.sessionEnd, true);
  // Observed on a real turn served by a local stand-in endpoint: write_file and
  // run_shell_command were each intercepted and each denied.
  assert.equal(capabilities.guards.beforeWrite, true);
  assert.equal(capabilities.guards.beforeShell, true);
  assert.equal(capabilities.context.beforeTurnInjection, true);

  // Still unobserved: no subagent ran, and this client fires no heartbeat.
  assert.equal(capabilities.lifecycle.childSessions, false);
  assert.equal(capabilities.lifecycle.heartbeat, false);
  assert.equal(capabilities.guards.beforeRead, false);
  assert.equal(capabilities.delivery.nextTurn, true);
  assert.equal(capabilities.delivery.livePush, false);
  assert.equal(capabilities.delivery.replyRoute, false);
});

test("a deny uses the shape this client acts on, not the one two others accept", () => {
  // Measured against a real session: {"decision":"block"} denies, and the
  // hookSpecificOutput shape that Claude Code and Kimi Code both honour does
  // not - the write went through every time. This is the single most portable-
  // looking mistake an adapter can make.
  assert.deepEqual(denyResponse("held by peer"),
    { decision: "block", reason: "held by peer" });
  assert.deepEqual(allowResponse(), {});
});

test("injection uses the envelope, which is the opposite of the deny contract", () => {
  // Also measured: a bare string and {"additionalContext": ...} are both
  // dropped silently here, while the envelope reaches the model. The two
  // contracts disagree within the same client, so neither was assumed.
  assert.deepEqual(injectResponse("2 peers"), { hookSpecificOutput: {
    hookEventName: "BeforeAgent", additionalContext: "2 peers" } });
  assert.deepEqual(injectResponse(""), {}, "solo injected an empty banner");
});

test("an edit declares the path it would write, and so does a shell write", async () => {
  const edit = normalizeGeminiHook(await captured("BeforeTool"));
  assert.equal(edit.tool, "write_file");
  assert.deepEqual([...edit.targets], ["/tmp/example-workspace/notes.txt"]);

  // The captured command is redacted content, and writes nothing.
  const shell = normalizeGeminiHook(await captured("BeforeTool-shell"));
  assert.equal(shell.tool, "run_shell_command");
  assert.deepEqual([...shell.targets], []);

  const writing = normalizeGeminiHook({ hook_event_name: "BeforeTool", session_id: "s",
    cwd: "/tmp", tool_name: "run_shell_command",
    tool_input: { command: "printf x > notes.txt" } });
  assert.deepEqual([...writing.targets], ["notes.txt"]);
});

test("captured payloads normalise and drop conversation content", async () => {
  const kinds = { SessionStart: "sessionStart", BeforeAgent: "beforeTurn",
    SessionEnd: "sessionEnd", PreCompress: "other", BeforeTool: "beforeTool",
    AfterTool: "afterTool", AfterAgent: "turnEnd" };

  for (const [event, kind] of Object.entries(kinds)) {
    const payload = await captured(event);
    const normalised = normalizeGeminiHook(payload);

    assert.equal(normalised.kind, kind, `${event} normalised wrongly`);
    assert.equal(normalised.sessionId, payload.session_id);
    assert.deepEqual(Object.keys(normalised).sort(),
      ["cwd", "kind", "model", "parentSessionId", "sessionId", "targets", "tool"]);
    assert.equal(JSON.stringify(normalised).includes("redacted"), false,
      `${event} carried conversation content through`);
  }
});

test("an unrecognised event or a payload without identity is refused", () => {
  assert.throws(() => normalizeGeminiHook({ hook_event_name: "Imaginary",
    session_id: "s", cwd: "/tmp" }), error => error.code === EXIT.DATA);
  assert.throws(() => normalizeGeminiHook({ hook_event_name: "SessionStart" }),
    error => error.code === EXIT.DATA);
});

test("doctor warns that the deny shape here is not the portable-looking one", async t => {
  const { context } = await fixture(t);
  const adapter = createGeminiCliAdapter();
  await adapter.install(context);

  const said = (await adapter.doctor(context)).diagnostics.join(" ");

  assert.match(said, /decision.*block/);
  assert.match(said, /does not deny on this client/);
  // Plan mode declares no write tool at all, so a guard that never fires there
  // is the client's doing, not a broken install.
  assert.match(said, /plan mode/);
});

test("the hook template is not shipped into the installed extension", async t => {
  // This client loads an extension's own hooks.json *in addition to* the
  // settings entries, so shipping the template registered ACC twice: once with
  // the shim, and once with the literal placeholder `acc-hook`, which is not on
  // PATH. Measured on 0.55.1: the client reported `acc-sessionStart` failing on
  // every event while the shimmed one quietly did the work, and its registry
  // held eighteen entries where thirteen were real.
  const { context } = await fixture(t);

  await createGeminiCliAdapter().install(context);

  const shipped = path.join(context.home, ".gemini", "extensions",
    "agents-can-communicate", "hooks");
  const present = await readdir(shipped);
  assert.equal(present.includes("hooks.json"), false,
    "the template shipped, so every event has a second entry that cannot run");
  assert.equal(present.includes("acc-hook.sh"), true, "the shim is missing");
});
