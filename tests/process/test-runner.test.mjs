import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { TEST_FILE_CONCURRENCY, nodeTestArguments }
  from "../../scripts/test-runner-plan.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const runner = path.join(repo, "scripts", "run-tests.mjs");

/**
 * The gate that failed silently.
 *
 * `npm test` used to be `node --test 'tests/**' 'packages/**'`. POSIX shells
 * expand those globs; PowerShell passes them through literally, and Node exits 0
 * when a pattern matches nothing. The Windows CI job ran zero tests and reported
 * success for as long as it existed - green, while testing nothing.
 */
test("the runner refuses to report success on an empty file list", async () => {
  const { stdout } = await run(process.execPath, [runner, "--list"], { cwd: repo });

  // A count printed before the run is what makes "zero" visible to a human
  // reading CI output, rather than a silence that looks like everything passed.
  assert.match(stdout, /^running \d+ test file\(s\)/m);
  const [, count] = stdout.match(/running (\d+) test file\(s\)/);
  assert.equal(Number(count) > 40, true, `only ${count} test files were found`);
});

test("file discovery does not depend on the shell", async () => {
  // Resolved in Node, so PowerShell and sh find the same files. This is the
  // whole reason the runner exists rather than a glob in package.json.
  const { stdout } = await run(process.execPath, [runner, "--list"], { cwd: repo });
  const listed = stdout.split("\n").filter(line => line.endsWith(".test.mjs"));

  assert.equal(listed.length > 40, true);
  assert.equal(listed.some(file => file.includes("prototype")), false,
    "the preserved prototype is not part of this suite");
  assert.equal(listed.some(file => file.includes("node_modules")), false);
});

test("the runner bounds file concurrency without weakening process races", () => {
  assert.equal(TEST_FILE_CONCURRENCY, 4);
  assert.deepEqual(nodeTestArguments(["first.test.mjs", "second.test.mjs"]), [
    "--test",
    "--test-concurrency=4",
    "first.test.mjs",
    "second.test.mjs",
  ]);
});
