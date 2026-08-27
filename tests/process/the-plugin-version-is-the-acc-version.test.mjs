import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { clientContext } from "@agents-can-communicate/cli";
import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";

const repo = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The version a client caches ACC's plugin under.
 *
 * It was a literal in each plugin manifest, updated by hand and by nobody. Three
 * releases later the package was 0.1.9 while every client had cached, listed and
 * reported `0.1.6` - including `installed_plugins.json`, which is what a person
 * reads to see which ACC they are running.
 *
 * Worse than cosmetic: the version string is how a client decides whether its
 * cached copy is still current. A bundle whose version never changes is a bundle
 * a client has no reason to replace.
 *
 * The tests that touched this all read the version out of the same manifest, so
 * they followed it wherever it went and could never see it drift.
 */
const accVersion = async () =>
  JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")).version;

async function home(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-plugin-version-")));
  const state = await realpath(await mkdtemp(path.join(tmpdir(), "acc-plugin-state-")));
  t.after(() => Promise.all([dir, state]
    .map(one => rm(one, { recursive: true, force: true }))));
  return clientContext(dir, state);
}

test("claude_code caches the plugin under the version of the acc that installed it", async t => {
  const context = await home(t);
  const version = await accVersion();

  await createClaudeCodeAdapter().install(context);

  const cache = path.join(context.home, ".claude", "plugins", "cache", "acc-local",
    "agents-can-communicate");
  assert.deepEqual(await readdir(cache), [version],
    "the cache directory is not named for the running acc");

  const manifest = JSON.parse(await readFile(
    path.join(cache, version, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.version, version);
});

test("what the client lists is the version that is running", async t => {
  // `installed_plugins.json` is where a person looks to answer "which ACC is
  // this". It reported 0.1.6 on a machine running 0.1.9.
  const context = await home(t);
  const version = await accVersion();

  await createClaudeCodeAdapter().install(context);

  const listed = await readFile(
    path.join(context.home, ".claude", "plugins", "installed_plugins.json"), "utf8");
  assert.equal(listed.includes(version), true,
    `installed_plugins.json does not mention ${version}: ${listed}`);
});

test("codex caches it under that version too", async t => {
  const context = await home(t);
  const version = await accVersion();

  await createCodexAdapter().install(context);

  const cache = path.join(context.home, ".codex", "plugins", "cache", "acc-local",
    "agents-can-communicate");
  assert.deepEqual(await readdir(cache), [version]);
});

test("no shipped manifest carries a version of its own to drift", async () => {
  // The fix is not "remember to bump three more files". There is one version on
  // this machine and the install stamps it; a second copy in the repository is
  // the thing that went stale.
  for (const manifest of [
    "packages/adapter-claude-code/plugin/.claude-plugin/plugin.json",
    "packages/adapter-codex/plugin/.codex-plugin/plugin.json",
    "packages/adapter-kimi/plugin/.kimi-plugin/plugin.json",
  ]) {
    const shipped = JSON.parse(await readFile(path.join(repo, manifest), "utf8"));
    assert.equal(shipped.version, undefined,
      `${manifest} still declares a version that nothing keeps in step`);
    assert.equal(typeof shipped.name, "string", `${manifest} lost its name`);
  }
});
