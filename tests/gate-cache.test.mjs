import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cache = await import("../scripts/gate-cache.mjs").catch(() => ({}));
const gitNames = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_QUARANTINE_PATH"];

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-cache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of gitNames) delete env[name];
  await run("git", ["init", "-q", root], { env });
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
  await writeFile(path.join(root, ".gitignore"), "node_modules/\nignored.txt\n");
  await run("git", ["add", "."], { cwd: root, env });
  const snapshots = [];
  t.after(async () => {
    for (const snapshot of snapshots) await cache.clearPassed("tests", snapshot);
  });
  const fingerprint = async extra => {
    assert.equal(typeof cache.testFingerprint, "function", "full-suite snapshot implementation is missing");
    const snapshot = await cache.testFingerprint(root, { env: { ...env, ...extra } });
    if (snapshot) snapshots.push(snapshot);
    return snapshot;
  };
  return { root, env, fingerprint };
}

// These are actual files and Git listings: omitting content, modes, newly listed
// inputs, or environment state must invalidate a previously successful suite.
test("full-suite receipts cover content, modes, file membership and environment", async t => {
  const { root, fingerprint } = await repository(t);
  await writeFile(path.join(root, "existing-extra.txt"), "existing relevant input\n");
  const initial = await fingerprint();
  assert.ok(initial?.key);
  assert.equal(await cache.hasPassed("tests", initial), false);
  await cache.savePassed("tests", initial);
  assert.equal(await cache.hasPassed("tests", await fingerprint()), true);
  const mutations = [
    () => writeFile(path.join(root, "source.mjs"), "export const value = 2;\n"),
    () => writeFile(path.join(root, "docs.txt"), "untracked but relevant\n"),
    () => rm(path.join(root, "existing-extra.txt")),
    ...(process.platform === "win32" ? [] : [() => chmod(path.join(root, "source.mjs"), 0o755)]),
  ];
  let previous = initial;
  for (const mutate of mutations) {
    await mutate();
    const next = await fingerprint();
    assert.ok(next?.key);
    assert.notEqual(next.key, previous.key);
    assert.equal(await cache.hasPassed("tests", next), false);
    await cache.savePassed("tests", next);
    previous = next;
  }
  assert.notEqual((await fingerprint({ ACC_TEST_REAL_FSYNC: "1" })).key, previous.key);
  assert.notEqual((await fingerprint({ NODE_OPTIONS: "--no-warnings" })).key, previous.key);
  assert.notEqual((await fingerprint({ ACC_CACHE_TEST_SECRET: "secret-value" })).key, previous.key);
  assert.equal((await fingerprint({ PWD: "/different", SHLVL: "42", GIT_DIR: "/wrong" })).key, previous.key);
  await writeFile(path.join(root, "ignored.txt"), "irrelevant\n");
  assert.equal((await fingerprint()).key, previous.key);
  await cache.clearPassed("tests", previous);
  assert.equal(await cache.hasPassed("tests", previous), false);
  await rm(path.join(root, "source.mjs"));
  assert.equal(await fingerprint(), null, "uncertain missing tracked input reused a receipt");
});

test("repository identity prevents another checkout from inheriting success", async t => {
  const first = await repository(t);
  const second = await repository(t);
  const snapshot = await first.fingerprint();
  await cache.savePassed("tests", snapshot);
  const other = await second.fingerprint();
  assert.notEqual(other.key, snapshot.key);
  assert.equal(await cache.hasPassed("tests", other), false);
});

test("changed symlink targets invalidate receipts", { skip: process.platform === "win32" }, async t => {
  const { root, env, fingerprint } = await repository(t);
  await writeFile(path.join(root, "target-a"), "same\n");
  await writeFile(path.join(root, "target-b"), "same\n");
  await symlink("target-a", path.join(root, "link"));
  await run("git", ["add", "link", "target-a", "target-b"], { cwd: root, env });
  const initial = await fingerprint();
  await cache.savePassed("tests", initial);
  await rm(path.join(root, "link"));
  await symlink("target-b", path.join(root, "link"));
  const changed = await fingerprint();
  assert.notEqual(changed.key, initial.key);
  assert.equal(await cache.hasPassed("tests", changed), false);
});

test("unknown installed dependencies and unresolved workspace links disable reuse", async t => {
  const { root, fingerprint } = await repository(t);
  await mkdir(path.join(root, "node_modules", "unexpected"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "unexpected", "index.mjs"), "export {};\n");
  assert.equal(await fingerprint(), null);
});

test("a non-Git directory never certifies a suite", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-cache-no-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(typeof cache.testFingerprint, "function", "full-suite snapshot implementation is missing");
  assert.equal(await cache.testFingerprint(root), null);
  assert.equal(await cache.hasPassed("tests", null), false);
});

test("expired or corrupt receipts rerun and do not store environment secrets", async t => {
  const { fingerprint } = await repository(t);
  const snapshot = await fingerprint({ ACC_CACHE_TEST_SECRET: "do-not-persist-this" });
  await cache.savePassed("tests", snapshot);
  // Locate this unique digest in the OS cache to exercise damaged on-disk state.
  const root = path.join(tmpdir(), `acc-development-gates-${process.getuid?.() ?? "user"}`);
  const names = await readdir(root);
  const file = path.join(root, names.find(name => name.includes(snapshot.key)));
  const raw = await readFile(file, "utf8");
  assert.doesNotMatch(raw, /do-not-persist-this|ACC_CACHE_TEST_SECRET/);
  await writeFile(file, "{broken");
  assert.equal(await cache.hasPassed("tests", snapshot), false);
  await cache.savePassed("tests", snapshot);
  const receipt = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...receipt, passedAt: String(Date.now()) }));
  assert.equal(await cache.hasPassed("tests", snapshot), false, "malformed receipt time was accepted");
  await writeFile(file, JSON.stringify({ ...receipt, passedAt: Date.now() - 25 * 60 * 60 * 1000 }));
  assert.equal(await cache.hasPassed("tests", snapshot), false);
});

test("workspace dependencies require real links to the exact local package", { skip: process.platform === "win32" }, async t => {
  const { root, fingerprint } = await repository(t);
  await mkdir(path.join(root, "packages", "a"), { recursive: true });
  await writeFile(path.join(root, "packages", "a", "package.json"), JSON.stringify({ name: "fixture-pkg" }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  await mkdir(path.join(root, "node_modules"));
  const link = path.join(root, "node_modules", "fixture-pkg");
  await symlink("../packages/a", link);
  const initial = await fingerprint();
  assert.ok(initial?.key, "valid installed workspace links disabled reuse");
  await cache.savePassed("tests", initial);
  await rm(link);
  await mkdir(link);
  assert.equal(await fingerprint(), null, "a copied mutable dependency reused the workspace receipt");
  await rm(link, { recursive: true });
  await symlink("../packages/absent", link);
  assert.equal(await fingerprint(), null, "a broken workspace link reused the receipt");
});

test("Git's injected default exec path normalizes, but a custom executable path invalidates", async t => {
  const { env, fingerprint } = await repository(t);
  const clean = { ...env };
  delete clean.GIT_EXEC_PATH;
  const defaultPath = (await run("git", ["--exec-path"], { env: clean })).stdout.trim();
  const pathKey = Object.keys(env).find(name => name.toUpperCase() === "PATH");
  const manualPath = env[pathKey].split(path.delimiter).filter(entry => entry !== defaultPath).join(path.delimiter);
  const initial = await fingerprint({ GIT_EXEC_PATH: undefined, [pathKey]: manualPath });
  const hook = await fingerprint({ GIT_EXEC_PATH: defaultPath, [pathKey]: manualPath });
  assert.equal(hook.key, initial.key, "a default Git hook variable disabled manual-suite reuse");
  // Keep both command searches on Git's actual binary. An OS shim selecting
  // another executable is intentionally a conservative cache miss.
  const pathBaseline = [defaultPath, manualPath].join(path.delimiter);
  const baseline = await fingerprint({ GIT_EXEC_PATH: undefined, [pathKey]: pathBaseline });
  const hookPath = await fingerprint({ GIT_EXEC_PATH: defaultPath,
    [pathKey]: [defaultPath, pathBaseline].join(path.delimiter) });
  assert.equal(hookPath.key, baseline.key, "Git's injected exec directory in PATH disabled reuse");
  const alteredPath = await fingerprint({ GIT_EXEC_PATH: defaultPath,
    [pathKey]: [defaultPath, "/custom/commands", pathBaseline].join(path.delimiter) });
  assert.notEqual(alteredPath.key, baseline.key, "an unrelated command-search change was ignored");
  const custom = await fingerprint({ GIT_EXEC_PATH: "/custom/git-tools" });
  assert.ok(custom?.key);
  assert.notEqual(custom.key, initial.key, "a custom Git executable path was silently ignored");
});

test("a transient edit restored to identical bytes changes the run observation stamp", async t => {
  const { root, fingerprint } = await repository(t);
  const file = path.join(root, "source.mjs");
  const bytes = await readFile(file);
  const before = await fingerprint();
  await cache.savePassed("tests", before);
  await writeFile(file, "export const temporary = true;\n");
  await writeFile(file, bytes);
  const after = await fingerprint();
  assert.equal(after.key, before.key, "content-identical subsequent runs unnecessarily invalidate success");
  assert.ok(before.stamp, "no observation stamp was captured");
  assert.notEqual(after.stamp, before.stamp, "a changing input can certify a mixed suite execution");
  assert.equal(await cache.hasPassed("tests", after), true, "historical receipts stopped being content-addressed");
  await writeFile(path.join(root, "transient.mjs"), "export {};\n");
  await rm(path.join(root, "transient.mjs"));
  const membership = await fingerprint();
  assert.equal(membership.key, after.key);
  assert.notEqual(membership.stamp, after.stamp, "transient input membership left no run observation");
});

test("ignored executable inputs disable suite reuse instead of hiding real runner discoveries", async t => {
  const { root, env, fingerprint } = await repository(t);
  await writeFile(path.join(root, ".gitignore"), "node_modules/\ncoverage/\n");
  await run("git", ["add", ".gitignore"], { cwd: root, env });
  for (const directory of ["tests", "packages", "bin", "scripts", "docs", "examples"]) {
    const file = path.join(root, directory, "coverage", "new.test.mjs");
    const before = await fingerprint();
    assert.ok(before?.key);
    await cache.savePassed("tests", before);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "import assert from 'node:assert/strict'; assert.fail('ignored input executes');\n");
    assert.equal(await fingerprint(), null, `${directory} has an executable input outside Git's listing`);
    await rm(path.join(root, directory), { recursive: true });
  }
});

test("ignored package-owned dependencies disable reuse", async t => {
  const { root, fingerprint } = await repository(t);
  const nested = path.join(root, "packages", "a", "node_modules", "dependency");
  const before = await fingerprint();
  assert.ok(before?.key);
  await cache.savePassed("tests", before);
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "index.mjs"), "export const current = true;\n");
  assert.equal(await fingerprint(), null, "ignored nested runtime dependencies were not accounted for");
});

test("transient installed dependency membership changes the observation stamp", { skip: process.platform === "win32" }, async t => {
  const { root, fingerprint } = await repository(t);
  await mkdir(path.join(root, "packages", "a"), { recursive: true });
  await writeFile(path.join(root, "packages", "a", "package.json"), JSON.stringify({ name: "@fixture/pkg" }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  const scope = path.join(root, "node_modules", "@fixture");
  await mkdir(scope, { recursive: true });
  await symlink("../../packages/a", path.join(scope, "pkg"));
  let before = await fingerprint();
  assert.ok(before?.key);
  for (const directory of [path.join(root, "node_modules"), scope]) {
    const dependency = path.join(directory, "transient");
    await mkdir(dependency);
    await writeFile(path.join(dependency, "index.mjs"), "export {};\n");
    await rm(dependency, { recursive: true });
    const after = await fingerprint();
    assert.equal(after.key, before.key);
    assert.notEqual(after.stamp, before.stamp, "a temporary installed dependency can certify a mixed run");
    before = after;
  }
});

// A reason collapsing to false hides whether re-execution was needed or reuse
// failed. Mutations of each branch must identify its own on-disk control.
test("receipt decisions distinguish hit, absent, expiry, invalid, scope and uncertain inputs", async t => {
  assert.equal(typeof cache.receiptDecision, "function", "receipt decision diagnostic is missing");
  const { fingerprint } = await repository(t);
  const snapshot = await fingerprint();
  assert.deepEqual(await cache.receiptDecision("tests", null, { ci: false }), { reused: false, reason: "inputs-uncertain" });
  assert.deepEqual(await cache.receiptDecision("tests", snapshot, { ci: false }), { reused: false, reason: "absent" });
  await cache.savePassed("tests", snapshot);
  const file = path.join(tmpdir(), `acc-development-gates-${process.getuid?.() ?? "user"}`, `tests-${snapshot.key}.json`);
  const receipt = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(await cache.receiptDecision("tests", snapshot, { now: receipt.passedAt, ci: false }), { reused: true, reason: "hit" });
  assert.deepEqual(await cache.receiptDecision("tests", snapshot, { now: receipt.passedAt + 86_400_000, ci: false }),
    { reused: false, reason: "expired" });
  await writeFile(file, "{broken");
  assert.deepEqual(await cache.receiptDecision("tests", snapshot, { ci: false }), { reused: false, reason: "invalid" });
  for (const bad of [null, { ...receipt, passedAt: "123" }, { ...receipt, version: 999 }, { ...receipt, key: "0".repeat(64) }]) {
    await writeFile(file, JSON.stringify(bad));
    assert.deepEqual(await cache.receiptDecision("tests", snapshot, { ci: false }), { reused: false, reason: "invalid" });
  }
  await writeFile(file, JSON.stringify({ ...receipt, kind: "syntax" }));
  assert.deepEqual(await cache.receiptDecision("tests", snapshot, { ci: false }), { reused: false, reason: "scope-mismatch" });
});

test("receipt diagnostics explain CI-disabled without changing Boolean cache callers", async t => {
  assert.equal(typeof cache.receiptDecision, "function", "receipt decision diagnostic is missing");
  const { fingerprint } = await repository(t);
  const snapshot = await fingerprint();
  await cache.savePassed("tests", snapshot);
  const previous = process.env.CI;
  process.env.CI = "1";
  try {
    assert.deepEqual(await cache.receiptDecision("tests", snapshot), { reused: false, reason: "ci-disabled" });
    assert.equal(await cache.hasPassed("tests", snapshot), true, "Boolean cache API changed its existing policy");
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  }
});
