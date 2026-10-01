// Measurement only (throwaway branch): what a slow hook was doing, and what the
// machine was doing at the same moment, from the logs tmp_hookcost.mjs and
// tmp_canary.mjs wrote.
// Usage: node scripts/tmp_tail_summary.mjs <hookcost.log> <canary.log> [slow ms]
import { readFile } from "node:fs/promises";

const parse = async file => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean)
  .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const records = await parse(process.argv[2] ?? "hookcost.log");
const canary = await parse(process.argv[3] ?? "canary.log");
const SLOW = Number(process.argv[4] ?? 3000);

const pct = (values, share) => { const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0; };
const spread = values => `p50 ${pct(values, 0.5)} p90 ${pct(values, 0.9)} p99 ${pct(values, 0.99)} `
  + `max ${Math.max(0, ...values)}`;
const iso = t => new Date(t).toISOString().slice(11, 23);

const hooks = records.filter(item => item.kind === "hook");
const files = records.filter(item => item.kind === "file");
console.log(`hooks ${hooks.length}: wall ${spread(hooks.map(h => h.wall))} ms; boot ${spread(hooks.map(h => h.boot))} ms`);
console.log(`  cpu ${spread(hooks.map(h => h.cpu))} ms; flush total ${spread(hooks.map(h => h.fsync.total))} ms`);
console.log(`  loop delay max ${spread(hooks.map(h => h.loopDelay?.max ?? 0))} ms`);
console.log(`  over 3 s ${hooks.filter(h => h.wall > 3000).length}, over 5 s ${hooks.filter(h => h.wall > 5000).length}, `
  + `failed open ${hooks.filter(h => /coordination unavailable|timed out/.test(h.err)).length}`);
if (canary.length > 0) {
  console.log(`canary ${canary.length} samples: timer late ${spread(canary.map(c => c.late))} ms; `
    + `4 KB flush ${spread(canary.map(c => c.flush))} ms; machine cpu ${spread(canary.map(c => c.cpu))} %`);
}

// Each test file's flushes, its own and those of the node processes under it.
const byPid = new Map(records.map(item => [item.pid, item]));
const fileOf = item => {
  for (let at = item, depth = 0; at !== undefined && depth < 6; at = byPid.get(at.ppid), depth += 1) {
    if (at.kind === "file") return at;
  }
  return null;
};
const flushesOf = new Map();
for (const item of records) {
  const file = fileOf(item);
  if (file !== null) flushesOf.set(file, (flushesOf.get(file) ?? 0) + item.fsync.n);
}
const window = (from, to) => {
  const seen = canary.filter(c => c.t >= from && c.t <= to + 500);
  const running = files.filter(f => f.start < to && f.start + f.wall > from)
    .sort((a, b) => (flushesOf.get(b) ?? 0) - (flushesOf.get(a) ?? 0))
    .map(f => `${f.what.split(/[\\/]/).slice(-2).join("/")} (${flushesOf.get(f) ?? 0} flushes)`);
  return { seen, running };
};
const describeWindow = (from, to) => {
  const { seen, running } = window(from, to);
  if (seen.length > 0) {
    console.log(`  canary: late max ${Math.max(...seen.map(c => c.late))} ms, flush max `
      + `${Math.max(...seen.map(c => c.flush))} ms, cpu ${seen.map(c => c.cpu).join(" ")} %`);
  }
  console.log(`  test files running (${running.length}): ${running.join(", ")}`);
};

const slow = hooks.filter(h => h.wall > SLOW || /coordination unavailable|timed out/.test(h.err))
  .sort((a, b) => a.start - b.start);
console.log(`\n=== ${slow.length} hooks over ${SLOW} ms or failed open`);
for (const hook of slow) {
  console.log(`\n${iso(hook.start)} ${hook.what} wall ${hook.wall} boot ${hook.boot} cpu ${hook.cpu} `
    + `loop delay max ${hook.loopDelay?.max} p99 ${hook.loopDelay?.p99} ms`);
  console.log(`  flush n ${hook.fsync.n} total ${hook.fsync.total} max ${hook.fsync.max}; slow [at,ms] `
    + JSON.stringify(hook.fsync.slow));
  console.log(`  phases [phase,at,ms] ${JSON.stringify(hook.phases)}`);
  console.log(`  children [at,ms,cmd] ${JSON.stringify(hook.children.map(c => [c.at, c.ms, c.cmd]))}`);
  if (hook.err) console.log(`  err ${JSON.stringify(hook.err)}`);
  describeWindow(hook.start, hook.start + hook.wall);
}

const stalls = canary.filter(c => c.late > 500 || c.flush > 500);
console.log(`\n=== ${stalls.length} canary samples with a timer over 500 ms late or a flush over 500 ms`);
for (const stall of stalls.slice(0, 40)) {
  console.log(`${iso(stall.t)} late ${stall.late} flush ${stall.flush} cpu ${stall.cpu}`);
  describeWindow(stall.t - 1000, stall.t);
}
