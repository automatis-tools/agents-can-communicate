// Measurement only (throwaway branch): the distribution of each disk and way of
// writing from tmp_flush_variants.mjs, overall and in the samples where a
// flush on that disk took over 250 ms.
import { readFile } from "node:fs/promises";

const samples = (await readFile(process.argv[2] ?? "variants.log", "utf8")).split("\n").filter(Boolean)
  .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const pct = (values, share) => { const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0; };
const spread = values => `p50 ${pct(values, 0.5)} p90 ${pct(values, 0.9)} p99 ${pct(values, 0.99)} `
  + `max ${Math.max(0, ...values)} ms`;
const keys = [...new Set(samples.flatMap(sample => Object.keys(sample)).filter(key => key !== "t"))];
console.log(`${samples.length} samples`);
for (const key of keys) console.log(`  ${key.padEnd(12)} ${spread(samples.map(sample => sample[key]))}`);
for (const disk of new Set(keys.map(key => key.split(".")[0]))) {
  const stalled = samples.filter(sample => sample[`${disk}.flush`] > 250);
  console.log(`\nwhile a ${disk} flush took over 250 ms (${stalled.length} samples):`);
  for (const key of keys) console.log(`  ${key.padEnd(12)} ${spread(stalled.map(sample => sample[key]))}`);
}
