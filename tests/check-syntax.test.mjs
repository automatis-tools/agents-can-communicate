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
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  await run("git", ["init", "-q", root], { env });
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  await writeFile(path.join(root, "untracked.mjs"), "export const = ;\n");
  await run("git", ["add", ...Object.keys(files)], { cwd: root, env });
  const check = () => run(process.execPath, [script, "--tracked"], { cwd: root, env })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => error);
  return { root, check };
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
