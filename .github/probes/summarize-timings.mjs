// Per-file wall time (dequeue to summary, in the parent) and per-test time from
// the timing reporter's lines. Writes a JSON digest and a Markdown table.
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [prefix, label] = process.argv.slice(2);
const directory = path.dirname(prefix);
const lines = readdirSync(directory)
  .filter(name => name.startsWith(path.basename(prefix)) && name.endsWith(".jsonl"))
  .flatMap(name => readFileSync(path.join(directory, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));

const repo = path.resolve(import.meta.dirname, "..", "..");
const relative = file => (file ? path.relative(repo, file).split(path.sep).join("/") : null);
const files = new Map();
const entry = file => {
  if (!files.has(file)) files.set(file, { file, start: null, end: null, testMs: 0, tests: 0, failed: 0 });
  return files.get(file);
};
const tests = [];
for (const line of lines) {
  const file = relative(line.file);
  if (!file) continue;
  if (line.type === "test:dequeue") entry(file).start ??= line.at;
  else if (line.type === "test:summary") entry(file).end = line.at;
  else if (line.type === "test:pass" || line.type === "test:fail") {
    const item = entry(file);
    item.testMs += line.ms; item.tests += 1;
    if (line.type === "test:fail") item.failed += 1;
    tests.push({ file, name: line.name, ms: line.ms, failed: line.type === "test:fail" });
  }
}
const perFile = [...files.values()].map(item => ({ ...item,
  wallMs: item.start !== null && item.end !== null ? item.end - item.start : null }));
const starts = perFile.map(item => item.start).filter(value => value !== null);
const ends = perFile.map(item => item.end).filter(value => value !== null);
const span = Math.max(...ends) - Math.min(...starts);
const sumWall = perFile.reduce((total, item) => total + (item.wallMs ?? 0), 0);
const sumTests = tests.reduce((total, item) => total + item.ms, 0);
const byWall = [...perFile].sort((a, b) => (b.wallMs ?? 0) - (a.wallMs ?? 0));
const digest = { label, files: perFile.length, tests: tests.length, failed: tests.filter(item => item.failed).length,
  spanMs: Math.round(span), sumFileWallMs: Math.round(sumWall), sumTestMs: Math.round(sumTests),
  effectiveParallelism: +(sumWall / span).toFixed(2),
  perFile: byWall.map(item => ({ file: item.file, wallMs: Math.round(item.wallMs ?? -1), testMs: Math.round(item.testMs),
    tests: item.tests, failed: item.failed, startMs: item.start === null ? null : Math.round(item.start - Math.min(...starts)) })),
  slowestTests: [...tests].sort((a, b) => b.ms - a.ms).slice(0, 60).map(item => ({ ...item, ms: Math.round(item.ms) })),
  failedTests: tests.filter(item => item.failed).map(item => `${item.file}: ${item.name}`) };
writeFileSync(`${prefix}.digest.json`, `${JSON.stringify(digest, null, 2)}\n`);

const seconds = ms => (ms / 1000).toFixed(1);
const table = [`### ${label}`, "",
  `files ${digest.files}, tests ${digest.tests}, failed ${digest.failed}; span ${seconds(span)} s; file wall sum ${seconds(sumWall)} s; ` +
  `test sum ${seconds(sumTests)} s; effective parallelism ${digest.effectiveParallelism}`, "",
  "| file | wall s | tests s | tests | starts at s |", "|---|---:|---:|---:|---:|",
  ...digest.perFile.slice(0, 40).map(item => `| ${item.file} | ${seconds(item.wallMs)} | ${seconds(item.testMs)} | ${item.tests} | ${seconds(item.startMs ?? 0)} |`),
  "", ...digest.failedTests.map(name => `- failed: ${name}`), ""].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
