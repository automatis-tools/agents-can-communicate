import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { removeFixture } from "../helpers/fixture-cleanup.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "acc-runner-reuse-"));
  t.after(() => removeFixture(base));
  const root = path.join(base, "work");
  const env = { ...process.env, ACC_TEST_FORCE_EXIT: "0" };
  for (const name of ["CI", "NODE_TEST_CONTEXT", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
    "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
    "GITHUB_STEP_SUMMARY", "ACC_TEST_TIMINGS"]) delete env[name];
  for (const directory of ["scripts", "tests", "packages"]) await mkdir(path.join(root, directory), { recursive: true });
  const failure = path.join(base, "failure");
  const change = path.join(base, "change");
  const restore = path.join(base, "restore");
  const counter = path.join(base, "counter");
  const source = (await readFile(path.join(repo, "scripts/run-tests.mjs"), "utf8"))
    .replaceAll(/from "(\.\/[^\"]+\.mjs)"/g, (_whole, relative) =>
      `from ${JSON.stringify(pathToFileURL(path.join(repo, "scripts", relative)).href)}`)
    .replace('from "../tests/helpers/packed-template.mjs"', 'from "./fake-template.mjs"')
    .replace('from "../tests/helpers/fixture-cleanup.mjs"',
      `from ${JSON.stringify(pathToFileURL(path.join(repo, "tests/helpers/fixture-cleanup.mjs")).href)}`);
  const runner = path.join(root, "scripts/run-tests.mjs");
  await writeFile(runner, source);
  await writeFile(path.join(root, "scripts/fake-template.mjs"), `
    import { mkdtemp, readFile, writeFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import path from "node:path";
    export async function createPackedTemplate() {
      const value = Number(await readFile(${JSON.stringify(counter)}, "utf8").catch(() => "0"));
      await writeFile(${JSON.stringify(counter)}, String(value + 1));
      return mkdtemp(path.join(tmpdir(), "acc-reuse-template-"));
    }
  `);
  await writeFile(path.join(root, "tests/probe.test.mjs"), `
    import assert from "node:assert/strict";
    import { readFile, writeFile } from "node:fs/promises";
    import test from "node:test";
    test("real test execution", async () => {
      assert.equal(await readFile(${JSON.stringify(failure)}, "utf8").catch(() => ""), "");
      if (await readFile(${JSON.stringify(change)}, "utf8").catch(() => "")) {
        const previous = await readFile(${JSON.stringify(path.join(root, "input.txt"))}, "utf8");
        await writeFile(${JSON.stringify(path.join(root, "input.txt"))}, String(Date.now()));
        if (await readFile(${JSON.stringify(restore)}, "utf8").catch(() => "")) {
          await writeFile(${JSON.stringify(path.join(root, "input.txt"))}, previous);
        }
      }
    });
  `);
  await writeFile(path.join(root, "input.txt"), "initial\n");
  await run("git", ["init", "-q", root], { env });
  await run("git", ["-C", root, "add", "."], { env });
  const invoke = (args = [], extraEnv = {}) => run(process.execPath, [runner, ...args], {
    cwd: root, env: { ...env, ...extraEnv }, timeout: 30_000,
  }).then(value => ({ ...value, code: 0 }), error => error);
  return { base, root, failure, change, restore, invoke,
    count: async () => Number(await readFile(counter, "utf8").catch(() => "0")) };
}

test("only a complete unchanged successful run can satisfy the next pre-push test gate", async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke()).code, 0);
  assert.equal(await f.count(), 1);
  const reused = await f.invoke(["--if-needed"]);
  assert.equal(reused.code, 0, reused.stderr);
  assert.match(reused.stdout, /already passed the full suite/);
  assert.equal(await f.count(), 1, "repacked an unchanged successful suite");
  await writeFile(path.join(f.root, "input.txt"), "changed\n");
  assert.equal((await f.invoke(["--if-needed"])).code, 0);
  assert.equal(await f.count(), 2, "changed input reused stale success");
  assert.equal((await f.invoke(["--shard", "1/1"])).code, 0);
  assert.equal((await f.invoke(["--if-needed"])).code, 0);
  assert.equal(await f.count(), 4, "a partial-selection run certified the next full gate");
});

test("a failed rerun and inputs changed during a green run both invalidate success", async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke()).code, 0);
  await writeFile(f.failure, "deliberate fixture failure");
  assert.equal((await f.invoke()).code, 1);
  await rm(f.failure);
  assert.equal((await f.invoke(["--if-needed"])).code, 0);
  assert.equal(await f.count(), 3, "a fresh failure left an older success reusable");
  await writeFile(f.change, "change inputs during execution");
  assert.equal((await f.invoke()).code, 0);
  await rm(f.change);
  assert.equal((await f.invoke(["--if-needed"])).code, 0);
  assert.equal(await f.count(), 5, "a green run certified files that changed while it ran");
});

test("CI always executes tests even when asked to reuse an earlier successful result", async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke([], { CI: "1" })).code, 0);
  assert.equal((await f.invoke(["--if-needed"], { CI: "1" })).code, 0);
  assert.equal(await f.count(), 2, "CI used a local success receipt instead of executing tests");
});

test("temporarily edited and restored files cannot receive a fresh success receipt", async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke()).code, 0);
  await writeFile(f.change, "change input");
  await writeFile(f.restore, "restore its bytes before finishing");
  assert.equal((await f.invoke()).code, 0);
  await rm(f.change);
  await rm(f.restore);
  assert.equal((await f.invoke(["--if-needed"])).code, 0);
  assert.equal(await f.count(), 3, "a mixed-input run certified bytes merely restored before its end");
});

test("an ignored newly discovered failing test cannot reuse an earlier successful suite", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, ".gitignore"), "coverage/\n");
  assert.equal((await f.invoke()).code, 0);
  await mkdir(path.join(f.root, "tests/coverage"));
  await writeFile(path.join(f.root, "tests/coverage/ignored.test.mjs"),
    'throw new Error("ignored discovered test must execute");\n');
  const result = await f.invoke(["--if-needed"]);
  assert.equal(result.code, 1, "ignored discovery reused an obsolete full-suite receipt");
  assert.match(result.stdout + result.stderr, /ignored discovered test must execute/);
  assert.equal(await f.count(), 2);
});
