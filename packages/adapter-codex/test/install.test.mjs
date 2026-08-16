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
    [".codex-plugin", "hooks.json", "skills"]);
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

test("every capability is false until a payload has been captured", () => {
  const adapter = createCodexAdapter();

  for (const [group, values] of Object.entries(adapter.capabilities)) {
    for (const [name, value] of Object.entries(values)) {
      assert.equal(value, false, `${group}.${name} was declared without evidence`);
    }
  }
});

test("doctor says the adapter is uncaptured and mentions hook trust", async t => {
  const { context } = await fixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  const report = await adapter.doctor(context);

  assert.equal(report.ok, false, "doctor reported healthy without captured payloads");
  assert.match(report.diagnostics.join(" "), /not captured/);
  assert.match(report.diagnostics.join(" "), /trusted/);
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

  assert.deepEqual(normalised, { kind: "beforeTool", sessionId: "abc-123",
    cwd: "/tmp/project", model: null, parentSessionId: null, tool: "Write" });
});
