// Measurement only: where a hook's time went, from the log tmp_hookcost.mjs wrote.
import { readFile } from "node:fs/promises";

const lines = (await readFile(process.argv[2] ?? "hookcost.log", "utf8")).split("\n").filter(Boolean)
  .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const hooks = lines.filter(line => line.kind === "hook");
const pct = (values, share) => { const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0; };
const ms = hooks.map(hook => hook.ms);
console.log(`hooks ${hooks.length}: p50 ${pct(ms, 0.5)} p90 ${pct(ms, 0.9)} p99 ${pct(ms, 0.99)} max ${Math.max(0, ...ms)} ms; `
  + `over 3 s ${ms.filter(v => v > 3000).length}, over 5 s ${ms.filter(v => v > 5000).length}`);
const flush = hooks.map(hook => hook.fsync.total);
console.log(`hook flush total: p50 ${pct(flush, 0.5)} p90 ${pct(flush, 0.9)} p99 ${pct(flush, 0.99)} max ${Math.max(0, ...flush)} ms; `
  + `single flush max ${Math.max(0, ...hooks.map(hook => hook.fsync.max))} ms`);
const byPhase = new Map();
for (const hook of hooks) for (const [phase, spent] of hook.phases ?? []) {
  const list = byPhase.get(phase) ?? []; list.push(spent); byPhase.set(phase, list);
}
for (const [phase, list] of byPhase) console.log(`  ${phase}: p50 ${pct(list, 0.5)} p99 ${pct(list, 0.99)} max ${Math.max(...list)} ms (${list.length})`);
console.log("\nslowest hooks:");
for (const hook of [...hooks].sort((a, b) => b.ms - a.ms).slice(0, 15)) console.log(JSON.stringify(hook));
const tests = lines.filter(line => line.kind === "test").sort((a, b) => b.fsync.max - a.fsync.max);
console.log("\ntest processes with the slowest single flush:");
for (const test of tests.slice(0, 10)) console.log(JSON.stringify(test));
