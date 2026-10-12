#!/usr/bin/env node
// Resolve the test files here rather than in the shell, and refuse to pass when
// there are none.
//
// `npm test` used to be `node --test 'tests/**/*.test.mjs' ...`. POSIX shells
// strip those quotes and expand the glob; PowerShell does not, and Node exits 0
// when a pattern matches nothing. The Windows CI job therefore ran zero tests
// and reported success - green, and testing nothing.
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TEST_FILE_CONCURRENCY, nodeTestArguments, skipsFsync, testBatches, testEnvironment,
  testFileTimeout } from "./test-runner-plan.mjs";
import { runnerOptions, shardFiles } from "./test-shards.mjs";
import { clearPassed, hasPassed, savePassed, testFingerprint } from "./gate-cache.mjs";
import { runTestBatch } from "./test-process.mjs";
import { createPackedTemplate } from "../tests/helpers/packed-template.mjs";
import { removeFixture } from "../tests/helpers/fixture-cleanup.mjs";

const repo = path.resolve(import.meta.dirname, "..");

// Everything that ships or guards. node_modules is not ours.
const ROOTS = ["tests", "packages"];
const SKIP = new Set(["node_modules", ".git"]);

async function collect(root) {
  const found = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".test.mjs")) found.push(full);
    }
  };
  await walk(path.join(repo, root));
  return found;
}

let options;
let files;
try {
  options = runnerOptions(process.argv.slice(2));
  if (!options.list) {
    nodeTestArguments([]); // Validate test deadline before allocating fixtures.
    testFileTimeout();
  }
  files = shardFiles((await Promise.all(ROOTS.map(collect))).flat().sort(), options.shard);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

if (files.length === 0) {
  console.error("no test files found - refusing to report success");
  process.exit(1);
}

console.log(`running ${files.length} test file(s) at concurrency ${TEST_FILE_CONCURRENCY}`
  + (options.shard === null ? "" : ` (shard ${options.shard.part}/${options.shard.count})`));
if (skipsFsync()) {
  console.log("fsync is skipped in this local macOS run (F_FULLFSYNC, about 4 ms each); "
    + "ACC_TEST_REAL_FSYNC=1 keeps it");
}

// `--list` prints what would run and stops. The suite uses it to assert the
// discovery is not empty without running itself recursively.
if (options.list) {
  // Written before exiting: a pipe takes 64 KiB at a time, and exiting at once cut
  // the list short where the checkout's path made it longer.
  await new Promise(resolve => process.stdout.write(`${files.join("\n")}\n`, resolve));
  process.exit(0);
}

// Relative to the repository, and in batches: see testBatches. A suite that fits
// one command line, as it does on POSIX, runs as a single batch.
const snapshot = process.env.CI ? null : await testFingerprint(repo);
if (options.ifNeeded && await hasPassed("test", snapshot)) {
  console.log("test gate: unchanged files and environment already passed the full suite");
  process.exit(0);
}
// A fresh failure must invalidate an older success for the same inputs.
await clearPassed("test", snapshot);
const reportDir = await mkdtemp(path.join(tmpdir(), "acc-test-report-"));
const batches = testBatches(files.map(file => path.relative(repo, file)), {
  testOptions: { timings: path.join(reportDir, "batch-00000.jsonl") },
});
const failed = [];
// Build once for this invocation, including all Windows command-line batches.
// Each scenario copies the installed consumer; none writes into this template.
let template;
const records = [];
const started = performance.now();
try {
  template = await createPackedTemplate();
  console.log(`packed template ready in ${((performance.now() - started) / 1000).toFixed(2)} s`);
  for (const [index, batch] of batches.entries()) {
    const report = path.join(reportDir, `batch-${index + 1}.jsonl`);
    const result = await runTestBatch(batch, { cwd: repo, report,
      env: { ...testEnvironment(), ACC_TEST_PACKED_TEMPLATE: template } });
    if (result.code !== 0) failed.push(index + 1);
    const lines = await readFile(report, "utf8").catch(() => "");
    records.push(...lines.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
    if (result.timeoutRecord) {
      const existing = records.findIndex(record => record.file === result.timeoutRecord.file);
      if (existing < 0) records.push(result.timeoutRecord);
      else records[existing] = result.timeoutRecord;
    }
  }
} finally {
  if (template !== undefined) await removeFixture(template);
  await removeFixture(reportDir);
}
if (process.env.ACC_TEST_TIMINGS) {
  const output = path.resolve(process.env.ACC_TEST_TIMINGS);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, records.map(record => JSON.stringify(record)).join("\n") + "\n");
}
console.log("slowest test files:");
const slowest = [...records].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
for (const record of slowest) {
  console.log(`  ${(record.durationMs / 1000).toFixed(2)} s ${path.relative(repo, record.file)}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = ["### Test file timings", "", "| File | Seconds | Result |", "| --- | ---: | --- |",
    ...slowest.map(record => `| ${path.relative(repo, record.file).replaceAll("|", "\\|")} | `
      + `${(record.durationMs / 1000).toFixed(2)} | ${record.success ? "passed" : "failed"} |`), ""].join("\n");
  // Optional reporting cannot turn successful validation into a failed gate.
  await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" }).catch(() => {});
}
if (batches.length > 1) {
  console.log(failed.length === 0 ? `all ${batches.length} batches passed`
    : `batch(es) ${failed.join(", ")} of ${batches.length} failed`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
if (failed.length === 0 && options.shard === null && snapshot !== null) {
  const after = await testFingerprint(repo);
  if (snapshot.key === after?.key && snapshot.stamp === after.stamp) await savePassed("test", snapshot);
}
