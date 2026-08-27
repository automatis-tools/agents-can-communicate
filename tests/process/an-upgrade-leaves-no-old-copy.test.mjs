import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { clientContext } from "@agents-can-communicate/cli";
import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";

const repo = fileURLToPath(new URL("../..", import.meta.url));

/**
 * What an upgrade leaves behind in a client's plugin cache.
 *
 * These clients cache a plugin under its version, so ACC's tree lands in a
 * directory named for the release that wrote it. Until 0.1.9 that name never
 * changed - every install landed in `0.1.6` and overwrote itself - so nothing
 * accumulated and nobody looked.
 *
 * Then the version started tracking the package, and the first upgrade after it
 * left this:
 *
 *   ~/.claude/plugins/cache/acc-local/agents-can-communicate/0.1.6
 *   ~/.claude/plugins/cache/acc-local/agents-can-communicate/0.1.9
 *   ~/.claude/plugins/cache/acc-local/agents-can-communicate/0.1.10
 *
 * Three copies of ACC in a home that should hold one. `acc uninstall` still
 * clears all of them - it removes the whole marketplace cache it created - so
 * this is litter rather than breakage, but it is litter ACC put there and told
 * nobody about.
 */
async function home(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-upgrade-")));
  const state = await realpath(await mkdtemp(path.join(tmpdir(), "acc-upgrade-state-")));
  t.after(() => Promise.all([dir, state]
    .map(one => rm(one, { recursive: true, force: true }))));
  return clientContext(dir, state);
}

const accVersion = async () => JSON.parse(
  await (await import("node:fs/promises")).readFile(
    path.join(repo, "package.json"), "utf8")).version;

/** A copy left by an earlier release, exactly as an upgrade would find one. */
async function olderCopy(root, version) {
  const dir = path.join(root, version, "hooks");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "acc-hook.sh"), "#!/bin/sh\n# from an old release\n");
  return path.join(root, version);
}

test("installing over an older copy leaves one copy, not two", async t => {
  const context = await home(t);
  const version = await accVersion();
  const root = path.join(context.home, ".claude", "plugins", "cache", "acc-local",
    "agents-can-communicate");
  await olderCopy(root, "0.1.6");
  await olderCopy(root, "0.1.9");

  await createClaudeCodeAdapter().install(context);

  assert.deepEqual(await readdir(root), [version],
    "an upgrade left the copies the previous releases wrote");
});

test("codex is left with one copy too", async t => {
  const context = await home(t);
  const version = await accVersion();
  const root = path.join(context.home, ".codex", "plugins", "cache", "acc-local",
    "agents-can-communicate");
  await olderCopy(root, "0.1.6");

  await createCodexAdapter().install(context);

  assert.deepEqual(await readdir(root), [version]);
});

test("only ACC's own plugin is tidied, never a neighbour's", async t => {
  // The marketplace cache root holds every plugin installed from it. Removing
  // that root once took a plugin the user had installed themselves - the reason
  // uninstall is careful about it - and this must not reintroduce that.
  const context = await home(t);
  const marketplace = path.join(context.home, ".claude", "plugins", "cache", "acc-local");
  const theirs = path.join(marketplace, "simplify", "2.0.0");
  await mkdir(theirs, { recursive: true });
  await writeFile(path.join(theirs, "plugin.json"), '{"name":"simplify"}\n');
  await olderCopy(path.join(marketplace, "agents-can-communicate"), "0.1.6");

  await createClaudeCodeAdapter().install(context);

  assert.deepEqual(await readdir(path.join(marketplace, "simplify")), ["2.0.0"],
    "a neighbour's cached plugin was removed");
  assert.equal(
    (await readdir(path.join(marketplace, "agents-can-communicate"))).length, 1);
});

test("a second install of the same version is still idempotent", async t => {
  const context = await home(t);
  const version = await accVersion();
  const root = path.join(context.home, ".claude", "plugins", "cache", "acc-local",
    "agents-can-communicate");

  await createClaudeCodeAdapter().install(context);
  await createClaudeCodeAdapter().install(context);

  assert.deepEqual(await readdir(root), [version]);
});
