import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runInShell } from "../helpers/host-shells.mjs";
import { shellWords } from "../helpers/owner-header.mjs";
import { CLAUDE_PLUGIN, pluginVersion } from "../helpers/plugin-version.mjs";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createAntigravityAdapter } from "@agents-can-communicate/adapter-antigravity";
import { fakeAgy } from "../../packages/adapter-antigravity/test/fake-agy.mjs";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

const windows = process.platform === "win32";
// The shell a client runs its hook command in on this host: sh on POSIX, and on
// Windows the one each client picked (tests/helpers/host-shells.mjs).
const onHost = (windowsShell, command) => ({ shell: windows ? windowsShell : "sh", command });
const hooksIn = wired => Object.values(wired.hooks)
  .flatMap(entries => entries.flatMap(entry => entry.hooks));

/**
 * The regression this file exists for.
 *
 * Three adapters shipped for a long time wiring a command named `acc-hook` that
 * did not exist anywhere in the repository. Nothing caught it: their tests
 * asserted what was written into the client's configuration, and a hook whose
 * command is missing fails silently on every event, so a real session would have
 * looked fine while ACC never saw it.
 *
 * These tests execute what was installed instead of reading it.
 */
const ADAPTERS = [
  { name: "codex", create: createCodexAdapter,
    context: home => ({ home, codexHome: path.join(home, ".codex") }),
    commands: async home => {
      // ACC's own marketplace root, not the one this client discovers by
      // itself: joining the user's put ACC's tree where the client never
      // looked, and enabled an id it never forms.
      const wired = JSON.parse(await readFile(path.join(home, ".agents", "acc-local",
        "plugins", "agents-can-communicate", "hooks.json"), "utf8"));
      // On Windows Codex runs `commandWindows` in place of `command`, in PowerShell.
      return hooksIn(wired).map(h => onHost("pwsh", windows ? h.commandWindows ?? h.command
        : h.command));
    } },
  { name: "claude_code", create: createClaudeCodeAdapter,
    context: home => ({ configDir: home }),
    commands: async home => {
      // The copy the client runs from, under the marketplace cache. Reading the
      // marketplace source instead would test a tree the client never loads.
      const root = path.join(home, "plugins", "cache", "acc-local",
        "agents-can-communicate", await pluginVersion(CLAUDE_PLUGIN));
      const wired = JSON.parse(await readFile(path.join(root, "hooks", "hooks.json"),
        "utf8"));
      const expand = text => text.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
      // A hook with `args` is the exec form, run with no shell; a plain command
      // runs in sh, or in Git Bash on Windows.
      return hooksIn(wired).map(h => (Array.isArray(h.args)
        ? { shell: "exec", command: expand(h.command), args: h.args.map(expand) }
        : onHost("bash", expand(h.command))));
    } },
  { name: "gemini_cli", create: createGeminiCliAdapter,
    context: home => ({ home }),
    commands: async home => {
      const settings = JSON.parse(await readFile(
        path.join(home, ".gemini", "settings.json"), "utf8"));
      return Object.values(settings.hooks)
        .flatMap(entries => entries.flatMap(entry => entry.hooks
          .filter(h => h.name?.startsWith("acc-")).map(h => onHost("powershell", h.command))));
    } },
  { name: "kimi", create: createKimiAdapter,
    context: home => ({ home }),
    commands: async home => {
      const config = await readFile(path.join(home, "config.toml"), "utf8");
      return config.split("\n").filter(line => line.startsWith("command = "))
        .map(line => onHost("cmd", line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'))
          .replace(/\\(["\\])/g, "$1")));
    } },
  { name: "antigravity", create: createAntigravityAdapter,
    // A location has to be named: this client registers either machine-wide or
    // per workspace, and ACC picks neither by itself. The probe stands in for
    // `agy -p "/hooks"`, which is the only thing that can confirm a
    // registration on this client - a write that parses can still load nothing.
    context: home => ({ home, antigravityHookLocation: "global",
      antigravityWorkspace: path.join(home, "project"), runAgy: fakeAgy().run,
      probeHooks: async () => ({ hooks: [{ name: "acc", enabled: true,
        actions: ["SessionStart", "PreInvocation", "Stop"].map(event => ({ event })) }] }) }),
    commands: async home => {
      const wired = JSON.parse(await readFile(
        path.join(home, ".gemini", "config", "hooks.json"), "utf8"));
      return Object.values(wired.acc)
        .flatMap(actions => actions.map(action => onHost("go-cmd", action.command)));
    },
    // This client sends no `hook_event_name`; the event is the argument the
    // registered command carries, and the session is a `conversationId`.
    payload: dir => ({ conversationId: "probe-antigravity", modelName: "gemini-3.8-flash-high",
      workspacePaths: [dir], transcriptPath: `${dir}/transcript`,
      artifactDirectoryPath: `${dir}/artifacts` }) },
  { name: "grok", create: createGrokAdapter,
    context: home => ({ home, grokHome: path.join(home, ".grok") }),
    commands: async home => {
      const wired = JSON.parse(await readFile(
        path.join(home, ".grok", "hooks", "acc.json"), "utf8"));
      return hooksIn(wired).map(h => onHost("pwsh", h.command));
    } },
];

/**
 * The files an installed hook names, each of which must exist.
 *
 * POSIX: the executable, which is the first quoted path or, for a bare command,
 * the first word, and has to be absolute. An exec-form hook names its program and
 * its script. A Windows shell form starts either an absolute node or the `node`
 * PATH finds - the portable and unquoted forms take it from PATH on purpose - and
 * every absolute path in it has to exist, the shim or runner among them.
 */
function namedFiles(name, hook) {
  if (hook.shell === "exec") {
    for (const file of [hook.command, hook.args[0]]) {
      assert.equal(path.isAbsolute(file), true, `${name} wired a relative command: ${file}`);
    }
    return [hook.command, hook.args[0]];
  }
  const { command } = hook;
  if (!windows) {
    const quoted = command.match(/"([^"]+)"|'([^']+)'/);
    const executable = quoted === null ? command.split(" ")[0] : (quoted[1] ?? quoted[2]);
    assert.equal(path.isAbsolute(executable), true, `${name} wired a relative command: ${command}`);
    return [executable];
  }
  // PowerShell's call operator is not part of the program.
  const words = shellWords(command.replace(/^& /, "").replace(/;.*$/, ""));
  assert.ok(path.win32.isAbsolute(words[0]) || words[0] === "node",
    `${name} wired a program that is neither absolute nor node: ${command}`);
  const files = words.filter(word => path.win32.isAbsolute(word));
  assert.ok(files.some(file => /\.mjs$/.test(file)), `${name} names no script: ${command}`);
  return files;
}

async function home(t, name) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), `acc-wiring-${name}-`)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Gemini and Claude Code merge into a settings file the user already owns.
  await mkdir(path.join(dir, ".gemini"), { recursive: true });
  await writeFile(path.join(dir, ".gemini", "settings.json"), "{}\n");
  await writeFile(path.join(dir, "settings.json"), "{}\n");
  await mkdir(path.join(dir, ".agents", "plugins"), { recursive: true });
  // The sequence shape this client parses; a map fails to load entirely.
  await writeFile(path.join(dir, ".agents", "plugins", "marketplace.json"),
    '{"name":"acc-local","plugins":[]}\n');
  return dir;
}

for (const adapter of ADAPTERS) {
  test(`${adapter.name}: every installed hook command names a file that exists`,
    async t => {
      const dir = await home(t, adapter.name);

      await adapter.create().install(adapter.context(dir));
      const commands = await adapter.commands(dir);

      assert.equal(commands.length > 0, true, "install wired no hooks at all");
      for (const hook of commands) {
        for (const file of namedFiles(adapter.name, hook)) {
          const info = await stat(file);
          assert.equal(info.isFile(), true, `${file} is not a file`);
        }
      }
    });

  test(`${adapter.name}: the installed command runs and answers a real payload`,
    async t => {
      const dir = await home(t, adapter.name);
      const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-wiring-data-")));
      t.after(() => rm(dataHome, { recursive: true, force: true }));

      await adapter.create().install(adapter.context(dir));
      const [hook] = await adapter.commands(dir);

      // Run it exactly as the client would: in the client's shell on this host,
      // or with none for an exec-form hook, with the payload on stdin. Exit 0 is
      // the contract - a hook must never break a session.
      const { stdout } = await runInShell(hook.shell, hook.command, { args: hook.args,
        env: { ...process.env, ACC_DATA_HOME: dataHome },
        input: JSON.stringify(adapter.payload?.(dir)
          ?? { hook_event_name: "SessionStart", session_id: `probe-${adapter.name}`,
            cwd: dir, source: "startup" }) });
      assert.equal(typeof stdout, "string");
    });
}

test("an adapter refuses to install when the runner is missing", async t => {
  const dir = await home(t, "missing");

  // The failure mode this whole file guards against, made explicit: if the
  // runtime is absent, installing anyway would wire silent failure.
  await assert.rejects(
    createKimiAdapter().install({ home: dir, runner: "/nonexistent/acc-hook.mjs" }),
    error => /runner/.test(error.message));
});
