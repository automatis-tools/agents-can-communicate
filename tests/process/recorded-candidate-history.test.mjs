import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { removeFixture } from "../helpers/fixture-cleanup.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const entry = "tests/acceptance/recorded-candidate.test.mjs";
const sourceTest = "the changelog's digest describes the code that is here now";

// These are literal shipped inputs, independent of the gate's PACKED list.
// The copied entry point retains both inventory tests; fixture invocations select
// only provenance because these deliberately tiny packages are not ACC releases.
async function fixture(t, { depth, stale = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "acc-candidate-history-"));
  t.after(() => removeFixture(base));
  const seed = path.join(base, "seed");
  await mkdir(seed);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key === "NODE_TEST_CONTEXT") delete env[key];
  }
  // Disable machine/user Git hooks and configuration only in these private repos.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = path.join(base, "no-global-config");
  const invoke = (cwd, command, args) => run(command, args, { cwd, env, timeout: 30_000 })
    .then(value => ({ ...value, code: 0 }), error => error);
  const gitAt = async (cwd, ...args) => {
    const result = await invoke(cwd, "git", args);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  const writeAt = async (root, file, bytes) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
  };
  await gitAt(seed, "init", "-q");
  await gitAt(seed, "config", "user.name", "Private provenance fixture");
  await gitAt(seed, "config", "user.email", "fixture@example.invalid");
  await writeAt(seed, "package.json", '{"name":"candidate-history-fixture","version":"1.0.0","type":"module"}\n');
  await writeAt(seed, "README.md", "# Predecessor\n");
  await writeAt(seed, "CHANGELOG.md", "# No record yet\n");
  const commit = async message => {
    await gitAt(seed, "add", "--all");
    await gitAt(seed, "commit", "-qm", message);
    return gitAt(seed, "rev-parse", "HEAD");
  };
  const predecessor = await commit("predecessor");
  await writeAt(seed, "README.md", "# Candidate shipped bytes\n");
  const recorded = await commit("candidate");
  const tree = await gitAt(seed, "rev-parse", "HEAD^{tree}");
  await writeAt(seed, "CHANGELOG.md", `| Built from | \`${recorded}\` |\n`);
  await commit("evidence");
  if (stale) {
    await writeAt(seed, "README.md", "# Changed shipped bytes\n");
    await commit("stale shipped bytes");
  }
  let root = seed;
  if (depth) {
    root = path.join(base, "shallow");
    await gitAt(base, "clone", "--quiet", "--no-local", "--depth", String(depth), pathToFileURL(seed).href, root);
    assert.equal(await gitAt(root, "rev-parse", "--is-shallow-repository"), "true");
  }
  // Never remove or modify shared project objects. File transport forbids local
  // hardlinks; these checks also protect the destructive private-tree control.
  assert.equal(await access(path.join(root, ".git/objects/info/alternates")).then(() => true, () => false), false);
  for (const directory of await readdir(path.join(root, ".git/objects"))) {
    const folder = path.join(root, ".git/objects", directory);
    if (!(await stat(folder)).isDirectory()) continue;
    for (const file of await readdir(folder)) assert.equal((await stat(path.join(folder, file))).nlink, 1);
  }
  await mkdir(path.join(root, "tests/acceptance"), { recursive: true });
  await copyFile(path.join(repo, entry), path.join(root, entry));
  await symlink(path.join(repo, "tests/helpers"), path.join(root, "tests/helpers"), "junction");
  const git = (...args) => gitAt(root, ...args);
  const probe = (...args) => invoke(root, "git", args);
  const gate = () => invoke(root, process.execPath,
    ["--test", "--test-reporter=tap", `--test-name-pattern=^${sourceTest}$`, entry]);
  return { root, recorded, predecessor, tree, git, probe, gate,
    write: (file, bytes) => writeAt(root, file, bytes) };
}

function passed(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 1\n/);
  assert.match(result.stdout, /# fail 0\n/);
}

function rejected(result, reason) {
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, reason);
  assert.match(result.stdout, /# fail 1\n/);
}

test("known recorded source accepts equal shipped bytes", async t => {
  const f = await fixture(t);
  passed(await f.gate());
});

test("known recorded source rejects committed shipped changes", async t => {
  const f = await fixture(t, { stale: true });
  rejected(await f.gate(), /shipped code changed[\s\S]*README\.md/);
});

test("missing recorded source in a shallow clone rejects stale shipped bytes", async t => {
  const f = await fixture(t, { depth: 1, stale: true });
  assert.notEqual((await f.probe("cat-file", "-e", `${f.recorded}^{commit}`)).code, 0);
  rejected(await f.gate(), /required source history/);
});

test("nonexistent well-formed recorded source rejects provenance", async t => {
  const f = await fixture(t);
  const absent = "ffffffffffffffffffffffffffffffffffffffff";
  assert.notEqual((await f.probe("cat-file", "-e", `${absent}^{commit}`)).code, 0);
  await f.write("CHANGELOG.md", `| Built from | \`${absent}\` |\n`);
  rejected(await f.gate(), /required source history/);
});

for (const [name, record] of [["absent", "# No record\n"],
  ["malformed", "| Built from | `not-a-git-hash` |\n"]]) {
  test(`${name} source record rejects provenance`, async t => {
    const f = await fixture(t);
    await f.write("CHANGELOG.md", record);
    rejected(await f.gate(), /the changelog records no commit/);
  });
}

test("known recorded commit with a missing required tree rejects provenance", async t => {
  const f = await fixture(t);
  assert.equal((await f.probe("cat-file", "-e", `${f.recorded}^{commit}`)).code, 0);
  const object = path.join(f.root, ".git/objects", f.tree.slice(0, 2), f.tree.slice(2));
  assert.equal((await stat(object)).nlink, 1);
  await rm(object);
  assert.notEqual((await f.probe("cat-file", "-e", f.tree)).code, 0);
  rejected(await f.gate(), /unable to read tree/);
});

for (const stale of [false, true]) {
  test(`shallow retained comparison objects ${stale ? "reject stale" : "accept equal"} shipped bytes without older ancestry`, async t => {
    const f = await fixture(t, { depth: stale ? 3 : 2, stale });
    assert.notEqual((await f.probe("cat-file", "-e", `${f.predecessor}^{commit}`)).code, 0);
    assert.equal((await f.probe("cat-file", "-e", `${f.recorded}^{commit}`)).code, 0);
    assert.equal((await f.probe("cat-file", "-e", `${f.recorded}^{tree}`)).code, 0);
    assert.equal((await f.probe("cat-file", "-e", "HEAD^{tree}")).code, 0);
    if (stale) rejected(await f.gate(), /shipped code changed[\s\S]*README\.md/);
    else passed(await f.gate());
  });
}

test("packed working-tree dirt rejects provenance", async t => {
  const f = await fixture(t);
  await f.write("README.md", "# Uncommitted shipped bytes\n");
  rejected(await f.gate(), /shipped code changed[\s\S]*README\.md/);
});

test("package test-only changes remain outside source provenance", async t => {
  const f = await fixture(t);
  await f.write("packages/core/test/fixture.txt", "unpublished test only\n");
  await f.git("add", "packages/core/test/fixture.txt");
  await f.git("commit", "-qm", "test-only change");
  await f.write("packages/core/test/fixture.txt", "unpublished test dirt\n");
  passed(await f.gate());
});
