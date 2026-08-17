import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

const run = promisify(execFile);

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
      const wired = JSON.parse(await readFile(path.join(home, ".agents", "plugins",
        "plugins", "agents-can-communicate", "hooks.json"), "utf8"));
      return Object.values(wired.hooks)
        .flatMap(entries => entries.flatMap(entry => entry.hooks.map(h => h.command)));
    } },
  { name: "claude_code", create: createClaudeCodeAdapter,
    context: home => ({ configDir: home }),
    commands: async home => {
      const wired = JSON.parse(await readFile(path.join(home, "plugins",
        "agents-can-communicate", ".claude-plugin", "..", "hooks", "hooks.json"), "utf8"));
      const root = path.join(home, "plugins", "agents-can-communicate");
      return Object.values(wired.hooks)
        .flatMap(entries => entries.flatMap(entry => entry.hooks.map(h =>
          h.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", root))));
    } },
  { name: "gemini_cli", create: createGeminiCliAdapter,
    context: home => ({ home }),
    commands: async home => {
      const settings = JSON.parse(await readFile(
        path.join(home, ".gemini", "settings.json"), "utf8"));
      return Object.values(settings.hooks)
        .flatMap(entries => entries.flatMap(entry => entry.hooks
          .filter(h => h.name?.startsWith("acc-")).map(h => h.command)));
    } },
  { name: "kimi", create: createKimiAdapter,
    context: home => ({ home }),
    commands: async home => {
      const config = await readFile(path.join(home, "config.toml"), "utf8");
      return config.split("\n").filter(line => line.startsWith("command = "))
        .map(line => line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'))
          .replace(/\\(["\\])/g, "$1"));
    } },
];

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
      for (const command of commands) {
        // The executable is the first quoted path, or the first word for a
        // bare command. Either way it must exist on disk.
        const quoted = command.match(/"([^"]+)"/);
        const executable = quoted === null ? command.split(" ")[0] : quoted[1];
        assert.equal(path.isAbsolute(executable), true,
          `${adapter.name} wired a relative command: ${command}`);
        const info = await stat(executable);
        assert.equal(info.isFile(), true, `${executable} is not a file`);
      }
    });

  test(`${adapter.name}: the installed command runs and answers a real payload`,
    async t => {
      const dir = await home(t, adapter.name);
      const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-wiring-data-")));
      t.after(() => rm(dataHome, { recursive: true, force: true }));

      await adapter.create().install(adapter.context(dir));
      const [command] = await adapter.commands(dir);

      // Run it exactly as the client would: through a shell, with the payload
      // on stdin. Exit 0 is the contract - a hook must never break a session.
      const child = run("/bin/sh", ["-c", command], {
        env: { ...process.env, ACC_DATA_HOME: dataHome },
      });
      child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
        session_id: `probe-${adapter.name}`, cwd: dir, source: "startup" }));

      const { stdout } = await child;
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
