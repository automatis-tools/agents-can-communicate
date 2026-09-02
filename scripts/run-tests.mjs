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

import { TEST_FILE_CONCURRENCY, nodeTestArguments } from "./test-runner-plan.mjs";

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

const child = spawn(process.execPath, nodeTestArguments(files),
  { stdio: "inherit", cwd: repo });
child.on("exit", code => { process.exitCode = code ?? 1; });
