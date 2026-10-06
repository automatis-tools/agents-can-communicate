#!/usr/bin/env node
// Syntax-check .mjs files, as many at once as the machine has processors.
//
// Was `find packages bin -name '*.mjs' | xargs -n1 node --check`, which does not
// exist on Windows - and the CI matrix includes it.
//
// Without arguments: every .mjs file under the shipped and test roots of this
// repository. With --tracked: every .mjs file git tracks in the repository the
// command runs in, which is what the pre-push hook and the Lint workflow check.
// One `node --check` after another took 19 s for 729 files on an 18-core Mac and
// 24-40 s on a four-vCPU Windows runner, where a pool took 8.5-12 s (2026-10-06).
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const ROOTS = ["packages", "bin", "scripts", "tests"];
const SKIP = new Set(["node_modules", ".git", "prototype", "migration"]);

async function collect(root) {
  const found = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".mjs")) found.push(full);
    }
  };
  await walk(path.join(repo, root));
  return found;
}

// Run where git runs a hook, at the top of the work tree, so the git variables a
// hook inherits select this repository without discovery.
async function tracked() {
  const { stdout } = await run("git", ["ls-files", "-z", "*.mjs"], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean).map(file => path.resolve(file));
}

const trackedOnly = process.argv.includes("--tracked");
const files = trackedOnly ? await tracked() : (await Promise.all(ROOTS.map(collect))).flat();
// A tracked list may be empty in a repository with no modules; the roots of this
// one never are, so there an empty list means the walk is broken.
if (files.length === 0 && !trackedOnly) {
  console.error("no .mjs files found - refusing to report success");
  process.exit(1);
}

const failures = [];
let next = 0;
const width = Math.max(1, Math.min(os.availableParallelism(), files.length));
await Promise.all(Array.from({ length: width }, async () => {
  while (next < files.length) {
    const file = files[next++];
    await run(process.execPath, ["--check", file])
      .catch(error => failures.push(`${file}\n${error.stderr}`));
  }
}));
if (failures.length > 0) {
  console.error(failures.sort().join("\n"));
  process.exit(1);
}
console.log(`syntax ok in ${files.length} file(s)`);
