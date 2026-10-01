// Measurement only (throwaway branch): run the three test files that failed on
// main's Windows job, two or three at a time as CI loads the runner, with every
// slow filesystem call and child process logged, and report where the time went.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROUNDS = Number(process.argv[2] ?? 6);
const log = path.resolve("slowops.log");
await writeFile(log, "");
const preload = pathToFileURL(path.resolve("scripts/tmp_slowops.mjs")).href;
const files = ["tests/process/session-history.test.mjs", "tests/process/session-resolution.test.mjs",
  "packages/hook-runner/test/runner.test.mjs"];
const run = file => new Promise(resolve => {
  const started = performance.now();
  const child = spawn(process.execPath, ["--test", file], { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: `--import ${preload}`, TMP_SLOWOPS_LOG: log,
      GIT_DIR: "", GIT_WORK_TREE: "" } });
  let out = "";
  child.stdout.on("data", data => { out += data; });
  child.stderr.on("data", data => { out += data; });
  // A file that does not finish in six minutes is stopped and reported, so the
  // summary is always printed.
  const timer = setTimeout(() => child.kill(), 360_000);
  child.on("exit", code => { clearTimeout(timer);
    resolve({ file, code, ms: Math.round(performance.now() - started), out }); });
});
let failures = 0;
for (let round = 0; round < ROUNDS; round += 1) {
  const results = await Promise.all(files.map(run));
  for (const result of results) {
    console.log(`round ${round} ${result.file}: exit ${result.code} in ${result.ms} ms`);
    if (result.code !== 0) {
      failures += 1;
      console.log(result.out.split("\n").filter(line => /✖|failed open|Error/.test(line)).slice(0, 6).join("\n"));
    }
  }
}
const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
console.log(`\nfailures ${failures}; slow operations logged ${lines.length}`);
const byOp = new Map();
for (const line of lines) {
  const [, ms, op] = /(\d+)ms (\S+)/.exec(line) ?? [];
  if (!op) continue;
  const entry = byOp.get(op) ?? { count: 0, total: 0, max: 0 };
  entry.count += 1; entry.total += Number(ms); entry.max = Math.max(entry.max, Number(ms));
  byOp.set(op, entry);
}
for (const [op, entry] of [...byOp].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${op}: ${entry.count} slow, total ${entry.total} ms, max ${entry.max} ms`);
}
console.log("\nslowest 40:");
for (const line of lines.sort((a, b) => Number(/(\d+)ms/.exec(b)[1]) - Number(/(\d+)ms/.exec(a)[1])).slice(0, 40)) {
  console.log(line.slice(0, 700));
}
