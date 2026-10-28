#!/usr/bin/env node
// Resolve the test files here rather than in the shell, and refuse to pass when
// there are none.
//
// `npm test` used to be `node --test 'tests/**/*.test.mjs' ...`. POSIX shells
// strip those quotes and expand the glob; PowerShell does not, and Node exits 0
// when a pattern matches nothing. The Windows CI job therefore ran zero tests
// and reported success - green, and testing nothing.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TEST_FILE_CONCURRENCY, nodeTestArguments, skipsFsync, testBatches, testEnvironment,
  testFileTimeout } from "./test-runner-plan.mjs";
import { runnerOptions } from "./test-shards.mjs";
import { invalidateGateProofs, hasPassed, receiptDecision, savePassed, testFingerprint } from "./gate-cache.mjs";
import { gateIdentity, readGateTimings, writeGateDiagnostic } from "./gate-diagnostics.mjs";
import { resolveTestSelection } from "./test-selection.mjs";
import { verifyScopedPackage } from "./scoped-package.mjs";
import { checkoutMatchesCommit } from "./push-tree-check.mjs";
import { discoverTestFiles } from "./validation-discovery.mjs";
import { runTestBatch } from "./test-process.mjs";
import { createPackedTemplate } from "../tests/helpers/packed-template.mjs";
import { removeFixture } from "../tests/helpers/fixture-cleanup.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const invocationStarted = performance.now();

let options;
let files;
let selection;
try {
  options = runnerOptions(process.argv.slice(2));
  if (process.env.NODE_TEST_CONTEXT && !options.list) {
    throw new Error("NODE_TEST_CONTEXT is set; run the test gate outside a Node test worker, "
      + "or clear NODE_TEST_CONTEXT in an explicit child fixture; --list remains available");
  }
  if (!options.list) {
    nodeTestArguments([]); // Validate test deadline before allocating fixtures.
    testFileTimeout();
  }
  selection = await resolveTestSelection({ repo, files: await discoverTestFiles(repo), options });
  files = selection.files;
  if (selection.fallbackReason) console.log(`test selection: ${selection.fallbackReason}; running full discovery`);
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

// Keep phase evidence separate from legacy file-only JSONL consumers.
const destination = process.env.ACC_GATE_DIAGNOSTIC
  ?? (process.env.ACC_TEST_TIMINGS ? `${process.env.ACC_TEST_TIMINGS}.manifest.json` : undefined);
const identity = destination ? await gateIdentity(repo) : {};
const context = { ...identity, platform: process.platform, node: process.version, scope: selection.scope,
  ...(selection.plan ? { planDigest: selection.plan.planDigest, selectionDigest: selection.plan.selectionDigest } : {}),
  ...(options.shard ? { shard: `${options.shard.part}/${options.shard.count}` } : {}),
  fileCount: files.length, concurrency: TEST_FILE_CONCURRENCY, fsyncMode: skipsFsync() ? "skipped" : "real" };
const events = [];
const records = [];
let timingsComplete = true;
let decision;
let inputDigest;
let outcome = "failed";
const phase = async (event, operation) => {
  const start = performance.now();
  let result = "failed";
  try { const value = await operation(); result = "passed"; return value; }
  finally { events.push({ schema: 1, ...context, event, durationMs: performance.now() - start, result }); }
};

async function execute() {
  const snapshot = await phase("fingerprint", () => process.env.CI ? null : testFingerprint(repo));
  inputDigest = snapshot?.key;
  events.at(-1).result = process.env.CI ? "ci-disabled" : snapshot ? "available" : "inputs-uncertain";
  decision = await phase("cache-lookup", () => receiptDecision(selection.kind, snapshot));
  events.at(-1).result = decision.reason;
  console.log(`test gate receipt: ${decision.reason}`);
  if (options.ifNeeded && decision.reused) {
    console.log(selection.scope === "docs" ? "documentation gate: unchanged files and environment already passed the documentation subset and package smoke"
      : "test gate: unchanged files and environment already passed the full suite");
    outcome = "reused";
    return;
  }
  // A fresh failure must invalidate an older success for the same inputs.
  await invalidateGateProofs(snapshot);
  const reportDir = await mkdtemp(path.join(tmpdir(), "acc-test-report-"));
  const batches = testBatches(files.map(file => path.relative(repo, file)), {
    testOptions: { timings: path.join(reportDir, "batch-00000.jsonl") },
  });
  const failed = [];
  let template;
  let retainTemplate = false;
  try {
    template = await phase("packed-template", () => createPackedTemplate());
    console.log(`packed template ready in ${(events.at(-1).durationMs / 1000).toFixed(2)} s`);
    for (const [index, batch] of batches.entries()) {
      const report = path.join(reportDir, `batch-${index + 1}.jsonl`);
      const result = await phase("batch-execution", () => runTestBatch(batch, { cwd: repo, report,
        env: { ...testEnvironment(), ACC_TEST_PACKED_TEMPLATE: template } }));
      Object.assign(events.at(-1), { fileCount: batch.length, result: result.code === 0 ? "passed" : "failed" });
      if (result.code !== 0) failed.push(index + 1);
      const timing = await readGateTimings(report);
      timingsComplete &&= timing.complete;
      records.push(...timing.records);
      if (result.timeoutRecord) {
        const existing = records.findIndex(record => record.file === result.timeoutRecord.file);
        if (existing < 0) records.push(result.timeoutRecord);
        else records[existing] = result.timeoutRecord;
      }
    }
    if (failed.length === 0 && selection.scope === "docs") {
      await phase("package-smoke", () => verifyScopedPackage({ repo, template }));
      console.log("documentation package smoke passed");
    }
  } catch (error) {
    retainTemplate = error.code === "SCOPED_PACKAGE_RETAINED";
    throw error;
  } finally {
    await phase("cleanup", async () => {
      try { if (template !== undefined && !retainTemplate) await removeFixture(template); }
      finally { await removeFixture(reportDir); }
    });
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
    await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" }).catch(() => {});
  }
  if (batches.length > 1) {
    console.log(failed.length === 0 ? `all ${batches.length} batches passed`
      : `batch(es) ${failed.join(", ")} of ${batches.length} failed`);
  }
  if (failed.length === 0 && selection.scope === "docs") console.log(`documentation subset passed: ${files.length} of ${selection.fullCount} files`);
  process.exitCode = failed.length === 0 ? 0 : 1;
  outcome = failed.length === 0 ? "passed" : "failed";
  if (failed.length === 0 && options.shard === null && snapshot !== null) {
    const after = await phase("fingerprint", () => testFingerprint(repo));
    events.at(-1).result = after ? "available" : "inputs-uncertain";
    let persistence = !after ? "inputs-uncertain" : snapshot.key !== after.key
      ? "fingerprint-changed" : "observation-changed";
    const start = performance.now();
    const checkoutValid = selection.scope !== "docs" || await checkoutMatchesCommit(repo, selection.plan.targetCommit);
    if (snapshot.key === after?.key && snapshot.stamp === after.stamp && checkoutValid) {
      await savePassed(selection.kind, snapshot);
      persistence = await hasPassed(selection.kind, snapshot) ? "saved" : "unavailable";
    }
    console.log(`test gate receipt after run: ${persistence}`);
    events.push({ schema: 1, ...context, event: "receipt-persistence", durationMs: performance.now() - start,
      result: persistence });
  }
}
try {
  await execute();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // Optional file timings must survive validation failures and cannot fail a
  // successful gate themselves. Their existing file-only JSONL stays intact.
  if (process.env.ACC_TEST_TIMINGS) {
    try {
      const output = path.resolve(process.env.ACC_TEST_TIMINGS);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    } catch { /* Best effort reporting. */ }
  }
  events.push({ schema: 1, ...context, event: "total", durationMs: performance.now() - invocationStarted, result: outcome });
  try {
    await writeGateDiagnostic(destination, { schema: 1, events, inputDigest, receiptDecision: decision,
      files: records.map(record => ({ ...record, file: path.relative(repo, record.file).split(path.sep).join("/") })),
      resultCounts: { selected: files.length, ...(timingsComplete ? { completed: records.length,
        passed: records.filter(record => record.success).length,
        failed: records.filter(record => !record.success).length } : {}) } });
  } catch { /* Even constructing optional evidence cannot change validation. */ }
}
