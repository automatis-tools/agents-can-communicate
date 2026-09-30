import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { COMMAND_LINE_LIMIT, TEST_FILE_CONCURRENCY, commandLineLength, fileConcurrency, nodeTestArguments,
  testBatches } from "../../scripts/test-runner-plan.mjs";

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

test("the runner bounds file concurrency without weakening process races", t => {
  const saved = { timeout: process.env.ACC_TEST_TIMEOUT_MS, exit: process.env.ACC_TEST_FORCE_EXIT };
  t.after(() => {
    for (const [name, value] of [["ACC_TEST_TIMEOUT_MS", saved.timeout], ["ACC_TEST_FORCE_EXIT", saved.exit]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  delete process.env.ACC_TEST_TIMEOUT_MS;
  delete process.env.ACC_TEST_FORCE_EXIT;
  // Windows starts a process and flushes a file several times slower, and four
  // heavy files at once on a four-vCPU windows-latest runner left a hook in one
  // of them past its budget.
  assert.equal(fileConcurrency("linux"), 4);
  assert.equal(fileConcurrency("darwin"), 4);
  assert.equal(fileConcurrency("win32"), 2);
  assert.equal(TEST_FILE_CONCURRENCY, fileConcurrency(process.platform));
  const concurrency = `--test-concurrency=${TEST_FILE_CONCURRENCY}`;
  assert.deepEqual(nodeTestArguments(["first.test.mjs", "second.test.mjs"]), [
    "--test",
    concurrency,
    "first.test.mjs",
    "second.test.mjs",
  ]);
  // CI names a per-test limit, so a hung test fails by name.
  process.env.ACC_TEST_TIMEOUT_MS = "600000";
  process.env.ACC_TEST_FORCE_EXIT = "1";
  assert.deepEqual(nodeTestArguments(["first.test.mjs"]),
    ["--test", concurrency, "--test-timeout=600000", "--test-force-exit", "first.test.mjs"]);
});

// Measured on windows-latest: 345 absolute test paths make a command line past
// Windows' 32,767-character limit, and the whole suite failed to start with
// "The filename or extension is too long".
test("no batch of test files makes a command line longer than Windows allows", () => {
  const files = Array.from({ length: 700 },
    (_, index) => `packages/adapter-something/test/a-fairly-long-test-name-${index}.test.mjs`);
  const batches = testBatches(files);

  assert.deepEqual(batches.flat(), files, "every file runs once, in order");
  assert.equal(batches.length > 1, true);
  for (const batch of batches) {
    assert.equal(commandLineLength([process.execPath, ...nodeTestArguments(batch)])
      <= COMMAND_LINE_LIMIT, true);
  }
});

test("a suite that fits one command line runs as one batch", () => {
  assert.deepEqual(testBatches(["a.test.mjs", "b.test.mjs"]), [["a.test.mjs", "b.test.mjs"]]);
});
