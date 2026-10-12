// Start times of ACC entry points in two checkouts, run in turn on one runner
// so its speed and load hit both alike (#270).
// usage: node startup-compare.mjs <runs> <out.json> <label=root>...
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [runs, out, ...pairs] = process.argv.slice(2);
const roots = pairs.map(pair => pair.split("=")).map(([label, root]) => [label, path.resolve(root)]);
const dataHome = mkdtempSync(path.join(os.tmpdir(), "acc-startup-"));
mkdirSync(path.join(dataHome, "work"));
const payload = JSON.stringify({ session_id: "startup", cwd: path.join(dataHome, "work"),
  hook_event_name: "UserPromptSubmit", prompt: "hi" });
const env = { ...process.env, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1" };
const cases = {
  node: ["-e", "0"],
  version: ["bin/acc.mjs", "version"],
  help: ["bin/acc.mjs", "help"],
  indicator: ["bin/acc-indicator.mjs", "--adapter", "claude_code", "--json"],
  hook: ["bin/acc-hook.mjs", "claude_code", "beforeTurn"],
};
const times = {};
for (let i = 0; i <= Number(runs); i += 1) {
  for (const [name, args] of Object.entries(cases)) for (const [label, root] of roots) {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { cwd: root, env,
      input: name === "hook" ? payload : "", encoding: "utf8" });
    const ms = performance.now() - start;
    if (result.status !== 0) throw new Error(`${label} ${name} exited ${result.status}: ${result.stderr}`);
    if (i > 0) (times[name] ??= {})[label] = [...(times[name]?.[label] ?? []), ms];
  }
}
rmSync(dataHome, { recursive: true, force: true });
const sorted = values => [...values].sort((a, b) => a - b);
const median = values => sorted(values)[Math.floor(values.length / 2)];
const summary = { platform: process.platform, cpus: os.availableParallelism(), model: os.cpus()[0]?.model,
  node: process.version, runs: Number(runs), medianMs: {}, minMs: {} };
for (const [name, byLabel] of Object.entries(times)) {
  summary.medianMs[name] = Object.fromEntries(Object.entries(byLabel).map(([label, v]) => [label, Math.round(median(v))]));
  summary.minMs[name] = Object.fromEntries(Object.entries(byLabel).map(([label, v]) => [label, Math.round(Math.min(...v))]));
}
console.log(JSON.stringify(summary, null, 1));
if (out) writeFileSync(out, `${JSON.stringify(summary)}\n`);
