import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { COMMAND_LINE_LIMIT, SKIP_FSYNC_PRELOAD, TEST_FILE_CONCURRENCY, commandLineLength, fileConcurrency,
  nodeTestArguments, skipsFsync, testBatches, testEnvironment } from "../../scripts/test-runner-plan.mjs";

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
  // Windows starts a process several times slower, and four files at once on a
  // four-vCPU windows-latest runner make each of them half as slow again as two.
  assert.equal(fileConcurrency("linux"), 4);
  assert.equal(fileConcurrency("darwin"), 4);
  assert.equal(fileConcurrency("win32"), 3);
  // Without flushes a many-core Mac takes two thirds of its processors, up to
  // twelve; a CI-sized machine stays at four, and Windows at three.
  assert.equal(fileConcurrency("darwin", { cpus: 18, fsyncSkipped: true }), 12);
  assert.equal(fileConcurrency("darwin", { cpus: 12, fsyncSkipped: true }), 8);
  assert.equal(fileConcurrency("darwin", { cpus: 3, fsyncSkipped: true }), 4);
  assert.equal(fileConcurrency("darwin", { cpus: 64, fsyncSkipped: true }), 12);
  assert.equal(fileConcurrency("darwin", { cpus: 18, fsyncSkipped: false }), 4);
  assert.equal(fileConcurrency("win32", { cpus: 18, fsyncSkipped: true }), 3);
  assert.equal(TEST_FILE_CONCURRENCY, fileConcurrency(process.platform, { fsyncSkipped: skipsFsync() }));
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

// A flush on macOS is an F_FULLFSYNC, about 4 ms, and the suite makes some
// 59,000. A local macOS run skips them; CI, every other platform, and anyone who
// asks for them keep them.
test("only a local macOS run skips fsync", () => {
  assert.equal(skipsFsync({ platform: "darwin", env: {} }), true);
  assert.equal(skipsFsync({ platform: "darwin", env: { CI: "true" } }), false);
  assert.equal(skipsFsync({ platform: "darwin", env: { ACC_TEST_REAL_FSYNC: "1" } }), false);
  assert.equal(skipsFsync({ platform: "linux", env: {} }), false);
  assert.equal(skipsFsync({ platform: "win32", env: {} }), false);
});

test("the suite's processes inherit the preload once, beside options already set", () => {
  const preload = `--import=${SKIP_FSYNC_PRELOAD}`;
  const local = testEnvironment({ NODE_OPTIONS: "--max-old-space-size=4096", KEEP: "1" }, { platform: "darwin" });
  assert.equal(local.NODE_OPTIONS, `--max-old-space-size=4096 ${preload}`);
  assert.equal(local.KEEP, "1");
  assert.equal(testEnvironment(local, { platform: "darwin" }).NODE_OPTIONS, local.NODE_OPTIONS,
    "a runner a test starts must not add the preload twice");
  assert.equal(testEnvironment({ CI: "true" }, { platform: "darwin" }).NODE_OPTIONS, undefined);
  assert.equal(testEnvironment({}, { platform: "linux" }).NODE_OPTIONS, undefined);
});

test("with the preload, no flush reaches the disk and the bytes are still written", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-skip-fsync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "written.txt");
  // A flush that made its system call would fail on a closed handle and on a
  // descriptor that does not exist (EBADF); a skipped one cannot.
  const source = `
    import fs from "node:fs";
    import { fdatasyncSync, fsyncSync } from "node:fs";
    import { open } from "node:fs/promises";
    const handle = await open(process.argv[1], "w");
    await handle.writeFile("kept");
    await handle.close();
    await handle.sync();
    await handle.datasync();
    fsyncSync(2 ** 30);
    fdatasyncSync(2 ** 30);
    await new Promise((resolve, reject) => fs.fsync(2 ** 30, error => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => fs.fdatasync(2 ** 30, error => (error ? reject(error) : resolve())));
    console.log("skipped");
  `;
  const args = ["--input-type=module", "--eval", source, file];
  // A local macOS suite already carries the preload in NODE_OPTIONS.
  const { NODE_OPTIONS: _inherited, ...env } = process.env;
  const { stdout } = await run(process.execPath, ["--import", SKIP_FSYNC_PRELOAD, ...args], { env });
  assert.equal(stdout.trim(), "skipped");
  assert.equal(await readFile(file, "utf8"), "kept");
  await assert.rejects(run(process.execPath, args, { env }), /EBADF|closed/,
    "without the preload the same flushes fail");
});
