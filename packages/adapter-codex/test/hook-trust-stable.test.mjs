import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installCodexPlugin } from "../src/install.mjs";
import { POSIX_FORM } from "../../../tests/helpers/platform-scope.mjs";

/**
 * The hash Codex trusts a plugin's hooks against.
 *
 * A port of codex-rs/hooks/src/engine/plugin_fingerprint.rs (0.167.1): every
 * entry under the plugin root, depth first in name order, as its relative path,
 * its kind, and for a file its length and bytes. Over ACC 0.14.1's and 0.15.0's
 * cached plugins on a real machine it gives exactly the two `trusted_content_hash`
 * values Codex recorded there.
 */
async function codexContentHash(root) {
  const hash = createHash("sha256").update("codex-plugin-bundle-v1");
  const u64 = value => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; };
  const pending = [root];
  while (pending.length > 0) {
    const entry = pending.pop();
    const name = Buffer.from(path.relative(root, entry));
    hash.update(u64(name.length)).update(name);
    const stats = await lstat(entry);
    if (stats.isDirectory()) {
      hash.update("directory");
      const names = (await readdir(entry)).toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      pending.push(...names.toReversed().map(child => path.join(entry, child)));
    } else {
      hash.update("file").update(u64(stats.size)).update(await readFile(entry));
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-trust-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runner = path.join(home, "acc-hook.mjs");
  await writeFile(runner, "// runner fixture\n");
  const context = { home, codexHome: path.join(home, ".codex"), runner, cli: runner,
    node: "/opt/node-a/bin/node", hostPlatform: POSIX_FORM };
  const cache = name => path.join(context.codexHome, "plugins", "cache", "acc-local", name);
  const source = name => path.join(home, ".agents", "acc-local", "plugins", name);
  const versions = async name => (await readdir(cache(name)).catch(() => [])).sort();
  const manifestVersion = async name => JSON.parse(await readFile(
    path.join(source(name), ".codex-plugin", "plugin.json"), "utf8")).version;
  const install = (accVersion, extra = {}) => installCodexPlugin({ ...context, accVersion, ...extra });
  return { context, cache, source, versions, manifestVersion, install };
}

const HOOKS = "agents-can-communicate-hooks";
const SKILL = "agents-can-communicate";

test("an ACC update that leaves the hooks alone leaves the copy Codex trusts byte for byte", async t => {
  const { cache, versions, manifestVersion, install } = await fixture(t);
  await install("0.16.0");
  const trusted = await codexContentHash(path.join(cache(HOOKS), "0.16.0"));

  await install("0.16.1", { keepPreviousVersion: "0.16.0" });

  assert.deepEqual(await versions(HOOKS), ["0.16.0"], "the update wrote a second hooks copy");
  assert.equal(await codexContentHash(path.join(cache(HOOKS), "0.16.0")), trusted,
    "Codex would ask to trust the same hooks again");
  // Codex replaces its cached copy whenever the marketplace copy names another
  // version, so the two must agree.
  assert.equal(await manifestVersion(HOOKS), "0.16.0");
  // The skill's plugin holds no hooks and nothing to trust: it says which ACC wrote it.
  assert.deepEqual(await versions(SKILL), ["0.16.0", "0.16.1"]);
  assert.equal(await manifestVersion(SKILL), "0.16.1");
});

test("a changed hook shim is a changed plugin, and the copy it replaces stays", async t => {
  const { cache, versions, manifestVersion, install } = await fixture(t);
  await install("0.16.0");
  const before = await codexContentHash(path.join(cache(HOOKS), "0.16.0"));

  // The shim pins the node it runs; a different one is a different hook.
  await install("0.17.0", { node: "/opt/node-b/bin/node" });

  assert.deepEqual(await versions(HOOKS), ["0.16.0", "0.17.0"]);
  assert.equal(await manifestVersion(HOOKS), "0.17.0");
  assert.notEqual(await codexContentHash(path.join(cache(HOOKS), "0.17.0")), before);
  // A session trusted against the old copy keeps running its hooks until it ends.
  assert.equal(await codexContentHash(path.join(cache(HOOKS), "0.16.0")), before);

  await install("0.18.0", { node: "/opt/node-c/bin/node" });
  assert.deepEqual(await versions(HOOKS), ["0.17.0", "0.18.0"], "an older copy holds no session");
});

test("the hooks copy keeps its version across reinstalls of the same ACC", async t => {
  const { versions, manifestVersion, install } = await fixture(t);
  await install("0.16.0");
  await install("0.16.0");
  assert.deepEqual(await versions(HOOKS), ["0.16.0"]);
  assert.equal(await manifestVersion(HOOKS), "0.16.0");
});

test("an update from the single plugin keeps the hook shim where open sessions call it", async t => {
  const { context, cache, source, versions, install } = await fixture(t);
  // What 0.15.0 left: one plugin whose cached copy holds the hooks, calling the
  // shim in its marketplace copy.
  await install("0.15.0");
  const old = path.join(cache(SKILL), "0.15.0");
  await cp(path.join(cache(HOOKS), "0.15.0"), old, { recursive: true, force: false });
  await rm(cache(HOOKS), { recursive: true, force: true });
  await mkdir(source(SKILL), { recursive: true });

  await install("0.16.0", { keepPreviousVersion: "0.15.0" });

  const shim = path.join(source(SKILL), "acc-hook.sh");
  assert.equal((await readFile(shim, "utf8")).includes(context.node), true,
    "a session open across the update lost the shim its hooks call");
  assert.deepEqual((await readdir(path.join(cache(SKILL), "0.16.0"))).sort(),
    [".codex-plugin", "acc-cli.sh", "assets", "skills"].sort(), "the new skill copy holds hooks");
  assert.deepEqual(await versions(HOOKS), ["0.16.0"]);

  // The next update removes the old copy, and with it the reason for the shim.
  await install("0.17.0", { keepPreviousVersion: "0.16.0" });
  assert.deepEqual(await versions(SKILL), ["0.16.0", "0.17.0"]);
  await assert.rejects(readFile(shim), error => error.code === "ENOENT");
});
