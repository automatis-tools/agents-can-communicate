// Measurement only (throwaway branch): the hook-heavy process tests that failed
// on Windows CI with a hook over its budget, run beside a packed test as the
// suite loads the runner, every hook's time and fail-open line recorded.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROUNDS = Number(process.argv[2] ?? 3);
const log = path.resolve("hookphases.log");
await writeFile(log, "");
const preload = pathToFileURL(path.resolve("scripts/tmp_hookphase.mjs")).href;
const files = ["tests/process/lapsed-claim.test.mjs", "tests/process/session-history.test.mjs",
  "tests/process/session-resolution.test.mjs", "tests/process/cursor.test.mjs",
  "tests/acceptance/managed-install-packed.test.mjs"];
const run = file => new Promise(resolve => {
  const started = performance.now();
  const child = spawn(process.execPath, ["--test", file], { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: `--import ${preload}`, TMP_HOOKPHASE_LOG: log,
      GIT_DIR: "", GIT_WORK_TREE: "" } });
  let out = "";
  child.stdout.on("data", data => { out += data; });
  child.stderr.on("data", data => { out += data; });
  const timer = setTimeout(() => child.kill(), 420_000);
  child.on("exit", code => { clearTimeout(timer);
    resolve({ file, code, ms: Math.round(performance.now() - started), out }); });
});
let failures = 0;
for (let round = 0; round < ROUNDS; round += 1) {
  for (const result of await Promise.all(files.map(run))) {
    console.log(`round ${round} ${result.file}: exit ${result.code} in ${result.ms} ms`);
    if (result.code !== 0) {
      failures += 1;
      console.log(result.out.split("\n").filter(line => /✖|failed open|Error|binding/.test(line)).slice(0, 6).join("\n"));
    }
  }
}
const hooks = (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
const times = hooks.map(hook => hook.ms).sort((a, b) => a - b);
const at = share => times[Math.min(times.length - 1, Math.floor(times.length * share))];
console.log(`\nfailures ${failures}; hooks ${hooks.length}; p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, `
  + `p99 ${at(0.99)} ms, max ${times.at(-1)} ms; over 3 s: ${times.filter(ms => ms > 3000).length}`);
const phases = new Map();
for (const hook of hooks.filter(item => /coordination unavailable/.test(item.err))) {
  const phase = /timed out while ([a-z ]+)\)/.exec(hook.err)?.[1] ?? hook.err.trim().slice(0, 120);
  phases.set(phase, (phases.get(phase) ?? 0) + 1);
}
for (const [phase, count] of phases) console.log(`${count}x failed open: ${phase}`);
for (const hook of hooks.filter(item => item.ms > 3000).slice(0, 20)) console.log(JSON.stringify(hook));
