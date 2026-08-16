import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");

// Node 20.12 and later refuse to spawn a .cmd or .bat without a shell (the
// CVE-2024-27980 fix), and npm on Windows is exactly that - a .cmd shim. So npm
// runs through a shell there, with arguments quoted because a temp path can
// contain spaces.
const isWindows = process.platform === "win32";
const runNpm = (args, options = {}) => (isWindows
  ? run("npm.cmd", args.map(argument => `"${argument}"`), { ...options, shell: true })
  : run("npm", args, options));

/** Files under a directory whose contents contain `needle`. */
async function filesContaining(root, needle) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const hits = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if ((await readFile(file, "utf8").catch(() => "")).includes(needle)) hits.push(file);
  }
  return hits;
}

/**
 * What a user actually receives.
 *
 * ACC publishes as one package carrying its workspaces, and the obvious way to
 * do that does not work: a tarball with `packages/` in `files` installs fine and
 * then fails on the first import, because `@agents-can-communicate/*` resolves
 * through workspace symlinks that exist only in the development tree. Verified
 * by doing it - `Cannot find package '@agents-can-communicate/protocol'` from a
 * clean install.
 *
 * `bundleDependencies` is what makes it work: npm packs each workspace package
 * into the tarball's own `node_modules`, so the specifiers resolve unchanged and
 * nothing has to be rewritten at build time. These tests exist because the
 * failure mode is invisible in development, where the symlinks are always there.
 */
async function packed(t) {
  const into = await realpath(await mkdtemp(path.join(tmpdir(), "acc-pack-")));
  t.after(() => rm(into, { recursive: true, force: true }));
  const { stdout } = await runNpm(["pack", "--pack-destination", into],
    { cwd: repo, env: { ...process.env } });
  const name = stdout.trim().split("\n").at(-1);
  return { into, tarball: path.join(into, name) };
}

const manifestOf = async tarball => JSON.parse((await run("tar",
  ["-xzOf", tarball, "package/package.json"])).stdout);

const entriesOf = async tarball => (await run("tar", ["-tzf", tarball])).stdout
  .split("\n").filter(Boolean).map(entry => entry.replace(/^package\//, ""));

test("the tarball carries the workspaces where imports can find them", async t => {
  const { tarball } = await packed(t);

  const manifest = await manifestOf(tarball);
  const entries = await entriesOf(tarball);

  assert.equal((manifest.bundleDependencies ?? []).length > 0,
    true, "nothing is bundled, so every internal import would fail on install");
  // Each package appears once, under node_modules. Shipping it twice - once
  // there and once under packages/ - is the tempting version of this.
  assert.equal(entries.some(entry =>
    entry.startsWith("node_modules/@agents-can-communicate/protocol/")), true);
  assert.equal(entries.some(entry => entry.startsWith("packages/")), false,
    "the workspace sources are shipped twice");
});

test("nothing private, local, or irrelevant is published", async t => {
  const { tarball } = await packed(t);

  const entries = await entriesOf(tarball);
  const top = new Set(entries.map(entry => entry.split("/")[0]));

  for (const excluded of [".agents", ".github", ".githooks", "tests", ".gitworktrees"]) {
    assert.equal(top.has(excluded), false, `${excluded}/ is in the tarball`);
  }
  // A capture or a fixture would carry a real path from the machine that made
  // it, and the runtime bus files carry live session state.
  for (const entry of entries) {
    assert.doesNotMatch(entry, /fixtures\//, `${entry} is capture material`);
    assert.doesNotMatch(entry, /\.jsonl$/, `${entry} looks like a transcript`);
  }
});

test("no absolute path from this machine survives into the tarball", async t => {
  const { tarball, into } = await packed(t);
  const extracted = path.join(into, "extracted");

  // Not `mkdir -p`: on Windows that is a cmd builtin, not something execFile
  // can spawn, and this test runs on the Windows matrix.
  await mkdir(extracted, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", extracted]);
  // Searched in Node rather than with grep. grep does not exist on Windows, and
  // the previous version swallowed that in a catch - so on the Windows matrix
  // this test passed while checking nothing at all.
  const hits = await filesContaining(path.join(extracted, "package"), "/Users/");

  // The hook shim bakes absolute paths at install time, which is correct - but
  // one baked at *pack* time would ship one machine's layout to everyone.
  assert.deepEqual(hits, [], `published files carry local paths:\n${hits.join("\n")}`);
});

test("a clean install runs the CLI and attaches a session", async t => {
  const { tarball } = await packed(t);
  const consumer = await realpath(await mkdtemp(path.join(tmpdir(), "acc-consumer-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-consumer-data-")));
  t.after(() => Promise.all([rm(consumer, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  await writeFile(path.join(consumer, "package.json"),
    '{"name":"consumer","version":"1.0.0","private":true}\n');

  await runNpm(["install", "--silent", tarball], { cwd: consumer });

  // The whole point: installed from a tarball, with no workspace anywhere.
  const env = { ...process.env, ACC_DATA_HOME: dataHome,
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const acc = path.join(consumer, "node_modules", ".bin", "acc");
  const hook = path.join(consumer, "node_modules", ".bin", "acc-hook");

  const child = run(hook, ["kimi", "sessionStart"], { cwd: consumer, env });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
    session_id: "packaged-probe", cwd: consumer, source: "startup" }));
  await child;

  const { stdout } = await run(acc, ["status", "--cwd", consumer, "--json"], { env });
  const status = JSON.parse(stdout).data;
  assert.equal(status.participants.length, 1, "the installed hook runtime never attached");
  assert.equal(status.participants[0].harness, "kimi");
});

test("the manifest declares the binaries and the engine it was certified on", async t => {
  const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));

  assert.deepEqual(Object.keys(manifest.bin ?? {}).sort(),
    ["acc", "acc-hook", "acc-mcp"]);
  assert.equal(manifest.private, undefined, "a private package cannot be published");
  assert.equal(manifest.license, "MIT");
  // Pinned to the production LTS line, never a Current-only release.
  assert.match(manifest.engines.node, /^>=2[0-9]$/);
});
