// Summaries and labels for a comparison run (#304). A figure is a benchmark only
// when the evidence supports one; operation counts are diagnostics, and a tail
// percentile without enough samples is named as insufficient evidence.
//
//   node scripts/measure/report.mjs <run.json>   renders a run's report again
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const BENCHMARK = Object.freeze({ rounds: 10, samplesPerSide: 100 });
export const TAIL_SAMPLES = Object.freeze({ p95: 100, p99: 1000 });

// Linear interpolation between closest ranks (the R-7 quantile).
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
const toMs = value => value === null ? null : Number((value / 1e6).toFixed(6));

/** Median, interquartile range and range of nanosecond samples, in milliseconds. */
export function summarize(samplesNs) {
  const sorted = [...samplesNs].sort((left, right) => left - right), n = sorted.length;
  const tail = (key, q) => n >= TAIL_SAMPLES[key] ? { value: toMs(quantile(sorted, q)), note: "reported" }
    : { value: null, note: `insufficient evidence: ${n} samples, ${TAIL_SAMPLES[key]} needed` };
  const p95 = tail("p95", 0.95), p99 = tail("p99", 0.99);
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
  return { n, medianMs: toMs(quantile(sorted, 0.5)), q1Ms: toMs(q1), q3Ms: toMs(q3),
    iqrMs: q1 === null ? null : toMs(q3 - q1), minMs: toMs(sorted[0] ?? null), maxMs: toMs(sorted.at(-1) ?? null),
    p95Ms: p95.value, p99Ms: p99.value, tails: { p95: p95.note, p99: p99.note } };
}

/** Per scenario: invalid, benchmark or smoke, with the reasons. */
export function classify(run) {
  const result = {};
  for (const { hash } of run.scenarios) {
    const children = run.children.filter(child => child.scenarioHash === hash);
    const reasons = [];
    for (const side of ["baseline", "candidate"]) {
      const own = children.filter(child => child.side === side);
      if (own.length === 0) reasons.push(`${side} has no runs`);
      if (own.some(child => child.error)) reasons.push(`${side} child failed`);
      if (own.some(child => child.validation.length > 0)) reasons.push(`${side} failed validation`);
    }
    // A negative control that validates means the validator missed the defect it plants.
    const candidate = children.filter(child => child.side === "candidate");
    if (run.candidateMutation && candidate.length > 0 && candidate.every(child => !child.error && child.validation.length === 0)) {
      reasons.push(`the negative control ${run.candidateMutation} passed validation`);
    }
    if (new Set(children.filter(child => !child.error).map(child => child.fixtureDigest)).size > 1) {
      reasons.push("the sides' fixtures differ");
    }
    // A round counts only with exactly one child of each side: the pair is what a round compares.
    const all = [...new Set(children.map(child => child.round))];
    const paired = all.filter(round => ["baseline", "candidate"].every(side =>
      children.filter(child => child.round === round && child.side === side).length === 1));
    const rounds = paired.length;
    const firsts = new Set(paired.map(round => children.find(child => child.round === round)?.side));
    const samples = side => children.filter(child => child.side === side && paired.includes(child.round))
      .reduce((total, child) => total + child.samplesNs.length, 0);
    const short = [];
    if (paired.length < all.length) short.push(`${all.length - paired.length} round(s) without one child of each side`);
    if (rounds < BENCHMARK.rounds) short.push(`${rounds} paired rounds, ${BENCHMARK.rounds} needed`);
    if (firsts.size < 2) short.push("the order never alternated");
    for (const side of ["baseline", "candidate"]) {
      if (samples(side) < BENCHMARK.samplesPerSide) short.push(`${side} has ${samples(side)} samples, ${BENCHMARK.samplesPerSide} needed`);
    }
    result[hash] = reasons.length > 0 ? { label: "invalid", reasons }
      : short.length > 0 ? { label: "smoke", reasons: short } : { label: "benchmark", reasons: [] };
  }
  return result;
}

/**
 * The candidate's median over the baseline's, round by round. The two sides of a
 * round run next to each other, so a change in machine load between rounds moves
 * both; the pooled medians alone can differ for equal code.
 */
export function pairedRatios(children) {
  const median = samples => quantile([...samples].sort((left, right) => left - right), 0.5);
  const ratios = [];
  for (const round of [...new Set(children.map(child => child.round))].sort((left, right) => left - right)) {
    const of = side => children.find(child => child.round === round && child.side === side && !child.error
      && child.samplesNs.length > 0);
    const baseline = of("baseline"), candidate = of("candidate");
    if (baseline && candidate) ratios.push(median(candidate.samplesNs) / median(baseline.samplesNs));
  }
  if (ratios.length === 0) return null;
  const sorted = [...ratios].sort((left, right) => left - right), fixed = value => Number(value.toFixed(3));
  return { rounds: ratios.length, median: fixed(quantile(sorted, 0.5)), min: fixed(sorted[0]), max: fixed(sorted.at(-1)) };
}

const range = values => {
  const numbers = values.filter(value => typeof value === "number");
  if (numbers.length === 0) return JSON.stringify(values[0] ?? null);
  const low = Math.min(...numbers), high = Math.max(...numbers);
  return low === high ? String(low) : `${low}..${high}`;
};
const flat = (value, prefix = "") => Object.entries(value ?? {}).flatMap(([key, item]) =>
  item !== null && typeof item === "object" && !Array.isArray(item) ? flat(item, `${prefix}${key}.`) : [[`${prefix}${key}`, item]]);

/** The markdown report beside run.json. */
export function renderReport(run) {
  const labels = classify(run), lines = [];
  lines.push(`# Cost comparison: ${run.probe}`, "");
  const side = value => [value.ref && `\`${value.ref}\``, value.commit, value.dirty && "dirty",
    value.sourcesHash && `sources \`${value.sourcesHash}\``].filter(Boolean).join(", ");
  lines.push(`- Baseline: ${side(run.sides.baseline)}`, `- Candidate: ${side(run.sides.candidate)}`);
  if (run.candidateMutation) lines.push(`- Candidate mutation: \`${run.candidateMutation}\` (a negative control)`);
  if (run.harness) lines.push(`- Harness: ${run.harness.commit}${run.harness.dirty ? ", dirty" : ""}`);
  if (run.host) lines.push(`- Host: ${[run.host.node, run.host.os, run.host.arch, run.host.cpuModel, run.host.cores && `${run.host.cores} cores`].filter(Boolean).join(", ")}`);
  if (run.durability) lines.push(`- Durability: fsync: ${run.durability.fsync}${run.durability.nodeOptions ? `; NODE_OPTIONS \`${run.durability.nodeOptions}\`` : ""}`);
  lines.push(`- Settings: ${run.settings.rounds} rounds, ${run.settings.samples} samples per child, ${run.settings.warmup} warm-up calls`, "");
  for (const { hash, scenario } of run.scenarios) {
    const verdict = labels[hash], children = run.children.filter(child => child.scenarioHash === hash);
    lines.push(`## ${JSON.stringify(scenario)}`, "", `Scenario hash \`${hash}\`. **${verdict.label}**${verdict.reasons.length ? `: ${verdict.reasons.join("; ")}` : ""}.`, "");
    for (const name of ["baseline", "candidate"]) {
      const digests = [...new Set(children.filter(child => child.side === name && child.fixtureDigest).map(child => child.fixtureDigest))];
      if (digests.length) lines.push(`- ${name} fixture: ${digests.map(value => `\`${value}\``).join(", ")}`);
    }
    const problems = children.flatMap(child => [child.error, child.cleanupError, ...child.validation.slice(0, 3)]
      .filter(Boolean).map(text => `round ${child.round} ${child.side}: ${text}`));
    if (problems.length) lines.push("", "Problems:", "", ...[...new Set(problems)].slice(0, 12).map(text => `- ${text}`));
    lines.push("");
    lines.push("| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |", "|---|---:|---:|---:|---:|---:|---:|---:|");
    const tails = [];
    for (const side of ["baseline", "candidate"]) {
      const summary = summarize(children.filter(child => child.side === side).flatMap(child => child.samplesNs));
      lines.push(`| ${side} | ${summary.n} | ${summary.medianMs} | ${summary.iqrMs} | ${summary.minMs} | ${summary.maxMs} | `
        + `${summary.p95Ms ?? "-"} | ${summary.p99Ms ?? "-"} |`);
      for (const [key, note] of Object.entries(summary.tails)) if (note !== "reported") tails.push(`${side} ${key}: ${note}`);
    }
    if (tails.length) lines.push("", `Tails not reported - ${tails.join("; ")}.`);
    const paired = pairedRatios(children);
    if (paired) {
      lines.push("", `Paired by round, candidate median / baseline median: ${paired.median} `
        + `(range ${paired.min}..${paired.max} over ${paired.rounds} rounds).`);
    }
    const keys = [...new Set(children.flatMap(child => flat(child.observations).map(([key]) => key)))].sort();
    if (keys.length) {
      lines.push("", "Diagnostic operation counts (what each side touched; never a validity condition):", "",
        "| Observation | baseline | candidate |", "|---|---:|---:|");
      for (const key of keys) {
        const values = side => children.filter(child => child.side === side)
          .map(child => Object.fromEntries(flat(child.observations))[key]);
        lines.push(`| ${key} | ${range(values("baseline"))} | ${range(values("candidate"))} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${renderReport(JSON.parse(await readFile(process.argv[2], "utf8")))}\n`);
}
