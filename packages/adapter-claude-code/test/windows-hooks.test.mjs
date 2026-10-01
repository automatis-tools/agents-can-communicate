// Claude Code on Windows runs a hook's shell form through Git Bash, or through
// PowerShell where Git is absent - where `sh` does not exist. The exec form
// (`command` plus `args`, Claude Code 2.1.139 and later) starts the program
// directly, with no shell to quote for.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installClaudePlugin } from "../src/install.mjs";

// The installer passes `platform` as a detection label ("win32-x64"); the shim
// form follows the host, named hostPlatform, as in every other adapter.
test("windows: every plugin hook starts the pinned node on the Node shim, with no shell", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-claude-win-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "acc-hook.mjs");
  const cli = path.join(root, "acc.mjs");
  await writeFile(runner, "");
  await writeFile(cli, "");
  const node = "C:\\Program Files\\nodejs\\node.exe";
  await installClaudePlugin({ configDir: path.join(root, ".claude"), runner, cli,
    node, hostPlatform: "win32" });
  const cache = path.join(root, ".claude", "plugins", "cache", "acc-local", "agents-can-communicate");
  const [version] = await readdir(cache);
  const hooks = JSON.parse(await readFile(path.join(cache, version, "hooks", "hooks.json"), "utf8"));
  const commands = Object.values(hooks.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  assert.equal(commands.length, 5);
  for (const hook of commands) {
    assert.equal(hook.type, "command");
    assert.equal(hook.command, node);
    assert.equal(hook.args[0], "${CLAUDE_PLUGIN_ROOT}/hooks/acc-hook.mjs");
    assert.equal(hook.args.length, 2);
  }
  assert.deepEqual(commands.map(hook => hook.args[1]),
    ["sessionStart", "beforeTurn", "guard", "finish", "sessionEnd"]);
  await readFile(path.join(cache, version, "hooks", "acc-hook.mjs"), "utf8");
});

test("a detection label in `platform` does not choose the shim form", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-claude-label-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "acc-hook.mjs");
  await writeFile(runner, "");
  await installClaudePlugin({ configDir: path.join(root, ".claude"), runner, cli: runner,
    platform: "win32-x64", hostPlatform: "linux" });
  const cache = path.join(root, ".claude", "plugins", "cache", "acc-local", "agents-can-communicate");
  const [version] = await readdir(cache);
  const hooks = await readdir(path.join(cache, version, "hooks"));
  assert.equal(hooks.includes("acc-hook.sh"), true, hooks.join(", "));
});
