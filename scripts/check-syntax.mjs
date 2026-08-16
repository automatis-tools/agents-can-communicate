#!/usr/bin/env node
// Syntax-check every shipped .mjs file.
//
// Was `find packages bin -name '*.mjs' | xargs -n1 node --check`, which does not
// exist on Windows - and the CI matrix includes it.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
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

const files = (await Promise.all(ROOTS.map(collect))).flat();
if (files.length === 0) {
  console.error("no .mjs files found - refusing to report success");
  process.exit(1);
}

const failures = [];
for (const file of files) {
  await run(process.execPath, ["--check", file])
    .catch(error => failures.push(`${file}\n${error.stderr}`));
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`syntax ok in ${files.length} file(s)`);
