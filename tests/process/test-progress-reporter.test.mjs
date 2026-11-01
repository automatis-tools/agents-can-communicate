import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import progress, { progressTracker } from "../../scripts/test-progress-reporter.mjs";
import { nodeTestArguments, PROGRESS_REPORTER } from "../../scripts/test-runner-plan.mjs";

const run = promisify(execFile);
// A child run inside this test's own runner would report to it instead.
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
const lines = async events => {
  const out = [];
  for await (const line of progress((async function* () { yield* events; })())) out.push(line);
  return out.join("");
};

test("progress names a file when it starts and when it ends, once each", async () => {
  const file = path.resolve("tests/example.test.mjs");
  const own = { file, name: file };
  const text = await lines([
    { type: "test:dequeue", data: own },
    { type: "test:dequeue", data: own },
    { type: "test:dequeue", data: { file, name: "a nested test" } },
    { type: "test:complete", data: { ...own, details: { passed: true } } },
    { type: "test:complete", data: { ...own, details: { passed: false } } },
  ]);
  assert.match(text, /^acc-test-file start tests\/example\.test\.mjs\nacc-test-file done tests\/example\.test\.mjs \d+\.\d s failed\n$/);
});

test("the tracker follows lines split across chunks and reports unfinished files", () => {
  const tracker = progressTracker();
  tracker.feed("acc-test-file start tests/a.test.mjs\r\nacc-test-file sta");
  tracker.feed("rt tests/b.test.mjs\n▶ spec output\nacc-test-file done tests/a.test.mjs 1.0 s passed\n");
  tracker.feed("acc-test-file start tests/c.test.mjs");
  assert.deepEqual(tracker.running(), ["tests/b.test.mjs"]);
  tracker.feed("\n");
  assert.deepEqual(tracker.running(), ["tests/b.test.mjs", "tests/c.test.mjs"]);
});

test("the tracker keeps a path with spaces whole", () => {
  const tracker = progressTracker();
  tracker.feed("acc-test-file start tests/my test.test.mjs\nacc-test-file start tests/other one.test.mjs\n");
  tracker.feed("acc-test-file done tests/other one.test.mjs 2.5 s failed\n");
  assert.deepEqual(tracker.running(), ["tests/my test.test.mjs"]);
  tracker.feed("acc-test-file done tests/my test.test.mjs 0.1 s passed\n");
  assert.deepEqual(tracker.running(), []);
});

test("ACC_TEST_PROGRESS adds the reporter only beside the timing reporter", () => {
  const with_ = nodeTestArguments(["x.test.mjs"], { timings: "t.jsonl", env: { ACC_TEST_PROGRESS: "1" } });
  assert.deepEqual(with_.slice(-3), [`--test-reporter=${PROGRESS_REPORTER}`, "--test-reporter-destination=stdout", "x.test.mjs"]);
  assert.equal(nodeTestArguments(["x.test.mjs"], { timings: "t.jsonl", env: {} }).includes(`--test-reporter=${PROGRESS_REPORTER}`), false);
  assert.equal(nodeTestArguments(["x.test.mjs"], { env: { ACC_TEST_PROGRESS: "1" } }).includes(`--test-reporter=${PROGRESS_REPORTER}`), false);
});

// The real runner: a file still running when output is read shows a start line
// and no done line, which is what names it at a deadline.
test("the real test runner reports start and end lines for each file", async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-progress-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["one", "two"]) {
    await writeFile(path.join(dir, `${name}.test.mjs`), "import test from 'node:test';\ntest('ok', () => {});\n");
  }
  const { stdout } = await run(process.execPath, nodeTestArguments(["one.test.mjs", "two.test.mjs"],
    { timings: path.join(dir, "timings.jsonl"), env: { ACC_TEST_PROGRESS: "1" } }),
    { cwd: dir, env: environment, timeout: 30_000 });
  const tracker = progressTracker();
  tracker.feed(stdout);
  for (const name of ["one", "two"]) {
    assert.match(stdout, new RegExp(`^acc-test-file start ${name}\\.test\\.mjs$`, "m"));
    assert.match(stdout, new RegExp(`^acc-test-file done ${name}\\.test\\.mjs \\d+\\.\\d s passed$`, "m"));
  }
  assert.deepEqual(tracker.running(), []);
});
