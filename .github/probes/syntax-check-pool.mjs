// The Syntax step as it is (one `node --check` after another) beside the same
// checks in a pool as wide as the runner. Prints both times.
import { execFile } from "node:child_process";
import os from "node:os";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const ROOTS = ["packages", "bin", "scripts", "tests"];
const SKIP = new Set(["node_modules", ".git", "prototype", "migration"]);
const files = [];
const walk = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith(".mjs")) files.push(full);
  }
};
for (const root of ROOTS) await walk(path.join(repo, root));

let start = performance.now();
for (const file of files) await run(process.execPath, ["--check", file]);
const sequential = performance.now() - start;

const width = os.availableParallelism();
start = performance.now();
let next = 0;
await Promise.all(Array.from({ length: width }, async () => {
  while (next < files.length) await run(process.execPath, ["--check", files[next++]]);
}));
const pooled = performance.now() - start;
console.log(JSON.stringify({ files: files.length, width, sequentialMs: Math.round(sequential), pooledMs: Math.round(pooled) }));
