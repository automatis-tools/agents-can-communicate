import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { removeFixture } from "./helpers/fixture-cleanup.mjs";

const run = promisify(execFile);
const script = path.resolve(import.meta.dirname, "..", "scripts", "check-syntax.mjs");

// The checks run in a pool now. A pool that dropped a file, or let one failure
// hide another, would still print "syntax ok" for the rest.

async function trackedRepository(t, files) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-syntax-")));
  t.after(() => removeFixture(root));
  const cacheHome = await mkdtemp(path.join(tmpdir(), "acc-syntax-cache-"));
  t.after(() => removeFixture(cacheHome));
  const env = { ...process.env, TMPDIR: cacheHome, TEMP: cacheHome, TMP: cacheHome };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  await run("git", ["init", "-q", root], { env });
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  await writeFile(path.join(root, "untracked.mjs"), "export const = ;\n");
  await run("git", ["add", ...Object.keys(files)], { cwd: root, env });
  const check = (extra = {}) => run(process.execPath, [script, "--tracked"], { cwd: root, env: { ...env, ...extra } })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => error);
  return { root, env, check };
}

const valid = count => Object.fromEntries(Array.from({ length: count },
  (_, index) => [`src/dir-${index % 5}/module-${index}.mjs`, `export const value${index} = ${index};\n`]));

test("every tracked module is checked, and only tracked ones", async t => {
  const { check } = await trackedRepository(t, valid(60));
  const result = await check();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /syntax ok in 60 file\(s\)/);
});

test("each module that does not parse is named, however many run at once", async t => {
  const files = { ...valid(60), "src/broken-one.mjs": "export const = 1;\n",
    "src/dir-3/broken-two.mjs": "import { from 'x';\n" };
  const { check } = await trackedRepository(t, files);
  const result = await check();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /broken-one\.mjs/);
  assert.match(result.stderr, /broken-two\.mjs/);
  assert.doesNotMatch(result.stderr, /module-\d+\.mjs/);
});

// Rechecking cached files or accepting a stale receipt would respectively erase
// the speedup or allow a tracked parse failure through the real checker.
test("unchanged parses are reused, but changed and previously broken modules are checked", async t => {
  const { root, env, check } = await trackedRepository(t, { "a.mjs": "export const value = 1;\n" });
  const first = await check();
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /1 checked, 0 cached/);
  const second = await check();
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /0 checked, 1 cached/);
  const changedOptions = await check({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --trace-warnings` });
  assert.equal(changedOptions.code, 0, changedOptions.stderr);
  assert.match(changedOptions.stdout, /1 checked, 0 cached/);
  await writeFile(path.join(root, "a.mjs"), "export const = ;\n");
  const broken = await check();
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /a\.mjs/);
  assert.equal((await check()).code, 1, "a failed parse was cached");
  await writeFile(path.join(root, "a.mjs"), "export const value = 2;\n");
  const repaired = await check();
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.match(repaired.stdout, /1 checked, 0 cached/);
  await writeFile(path.join(root, "new.mjs"), "export const = ;\n");
  await run("git", ["add", "new.mjs"], { cwd: root, env });
  assert.equal((await check()).code, 1, "a newly tracked file was omitted");
});
