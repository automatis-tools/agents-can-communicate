#!/usr/bin/env node
// Resolve the test files here rather than in the shell, and refuse to pass when
// there are none.
//
// `npm test` used to be `node --test 'tests/**/*.test.mjs' ...`. POSIX shells
// strip those quotes and expand the glob; PowerShell does not, and Node exits 0
// when a pattern matches nothing. The Windows CI job therefore ran zero tests
// and reported success - green, and testing nothing.
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { TEST_FILE_CONCURRENCY, nodeTestArguments, testBatches } from "./test-runner-plan.mjs";
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

const files = (await Promise.all(ROOTS.map(collect))).flat().sort();

if (files.length === 0) {
  console.error("no test files found - refusing to report success");
  process.exit(1);
}

console.log(`running ${files.length} test file(s) at concurrency ${TEST_FILE_CONCURRENCY}`);

// `--list` prints what would run and stops. The suite uses it to assert the
// discovery is not empty without running itself recursively.
if (process.argv.includes("--list")) {
  console.log(files.join("\n"));
  process.exit(0);
}

// Relative to the repository, and in batches: see testBatches. A suite that fits
// one command line, as it does on POSIX, runs as a single batch.
const batches = testBatches(files.map(file => path.relative(repo, file)));
const failed = [];
// Build once for this invocation, including all Windows command-line batches.
// Each scenario copies the installed consumer; none writes into this template.
const templateStarted = performance.now();
const template = await createPackedTemplate();
console.log(`packed template in ${Math.round(performance.now() - templateStarted)} ms`);
try {
  for (const [index, batch] of batches.entries()) {
    // Measurement branch only: a concurrency override and a timing reporter,
    // neither inherited by a runner a test starts.
    const args = nodeTestArguments(batch);
    const { ACC_MEASURE_CONCURRENCY: measuredConcurrency, ACC_MEASURE_TIMINGS: timings, ...childEnv } = process.env;
    if (measuredConcurrency) args[1] = `--test-concurrency=${measuredConcurrency}`;
    if (timings) args.splice(1, 0, "--test-reporter=spec", "--test-reporter-destination=stdout",
      `--test-reporter=${path.join(repo, ".github", "probes", "file-timing-reporter.mjs")}`,
      `--test-reporter-destination=${timings}.${index + 1}.jsonl`);
    const code = await new Promise(resolve => {
      spawn(process.execPath, args, { stdio: "inherit", cwd: repo,
        env: { ...childEnv, ACC_TEST_PACKED_TEMPLATE: template } })
        .on("error", () => resolve(1))
        .on("exit", exitCode => resolve(exitCode ?? 1));
    });
    if (code !== 0) failed.push(index + 1);
  }
} finally {
  await removeFixture(template);
}
if (batches.length > 1) {
  console.log(failed.length === 0 ? `all ${batches.length} batches passed`
    : `batch(es) ${failed.join(", ")} of ${batches.length} failed`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
