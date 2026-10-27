import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify, pairedRatios, renderReport, summarize } from "../../scripts/measure/report.mjs";
import { runProcess } from "../helpers/run-process.mjs";

// #304: a report says what its evidence supports - a benchmark, a smoke
// observation, a diagnostic, or not enough samples for a tail.
const ms = value => value * 1e6;

test("a summary gives the median, spread and range, and tails only with enough samples", () => {
  const summary = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9].map(ms));
  assert.equal(summary.n, 9);
  assert.equal(summary.medianMs, 5);
  assert.equal(summary.q1Ms, 3);
  assert.equal(summary.q3Ms, 7);
  assert.equal(summary.iqrMs, 4);
  assert.equal(summary.minMs, 1);
  assert.equal(summary.maxMs, 9);
  assert.equal(summary.p95Ms, null);
  assert.match(summary.tails.p95, /insufficient evidence: 9 samples, 100 needed/);
  const hundred = summarize(Array.from({ length: 100 }, (_, index) => ms(index + 1)));
  assert.equal(typeof hundred.p95Ms, "number");
  assert.equal(hundred.p99Ms, null);
  assert.match(hundred.tails.p99, /1000 needed/);
  assert.equal(typeof summarize(Array.from({ length: 1000 }, (_, index) => ms(index))).p99Ms, "number");
});

function run({ rounds = 10, samples = 10, alternate = true, failures = [], digests = ["d", "d"] } = {}) {
  const children = [];
  for (let round = 0; round < rounds; round++) {
    const order = alternate && round % 2 === 1 ? ["candidate", "baseline"] : ["baseline", "candidate"];
    for (const side of order) {
      children.push({ round, side, scenarioHash: "s", fixtureDigest: side === "baseline" ? digests[0] : digests[1],
        validation: round === 0 && side === "candidate" ? failures : [],
        samplesNs: Array.from({ length: samples }, (_, index) => ms(side === "baseline" ? 10 + index : 5 + index)),
        observations: { receiptVisits: side === "baseline" ? 100 : 10 } });
    }
  }
  return { probe: "attention", settings: { rounds, samples, warmup: 1 },
    scenarios: [{ hash: "s", scenario: { probe: "attention", ownRequests: 8 } }], children,
    sides: { baseline: { label: "baseline" }, candidate: { label: "candidate" } } };
}

test("ten alternating rounds with one hundred samples per side and valid work are a benchmark", () => {
  assert.equal(classify(run()).s.label, "benchmark");
});

test("a round without one child of each side does not count toward a benchmark", () => {
  // Twenty samples per child: nine paired rounds would still hold enough samples.
  const missing = run({ samples: 20 });
  missing.children = missing.children.filter(child => !(child.round === 4 && child.side === "candidate"));
  const verdict = classify(missing).s;
  assert.equal(verdict.label, "smoke");
  assert.match(verdict.reasons.join(), /1 round\(s\) without one child of each side/);
  assert.match(verdict.reasons.join(), /9 paired rounds, 10 needed/);
  const doubled = run({ samples: 20 });
  doubled.children.push({ ...doubled.children.find(child => child.round === 2 && child.side === "baseline") });
  assert.equal(classify(doubled).s.label, "smoke");
});

test("fewer rounds, fewer samples or no alternation make it smoke", () => {
  assert.equal(classify(run({ rounds: 9, samples: 20 })).s.label, "smoke");
  assert.equal(classify(run({ samples: 9 })).s.label, "smoke");
  assert.equal(classify(run({ alternate: false })).s.label, "smoke");
});

test("failed validation or different fixtures make the comparison invalid", () => {
  const failed = classify(run({ failures: ["attention: missing 1 x item"] })).s;
  assert.equal(failed.label, "invalid");
  assert.match(failed.reasons.join(), /candidate failed validation/);
  assert.match(classify(run({ digests: ["a", "b"] })).s.reasons.join(), /fixtures differ/);
});

test("a child that failed makes its comparison invalid, and the report says why", () => {
  const value = run();
  value.children[0] = { ...value.children[0], error: "baseline child timed out after 1 ms", samplesNs: [] };
  assert.match(classify(value).s.reasons.join(), /baseline child failed/);
  assert.match(renderReport({ ...value, candidateMutation: "drop-one" }), /timed out after 1 ms[\s\S]*drop-one|drop-one[\s\S]*timed out after 1 ms/);
});

test("a negative control that passes validation is invalid, never a benchmark", () => {
  const passed = classify({ ...run(), candidateMutation: "drop-one" }).s;
  assert.equal(passed.label, "invalid");
  assert.match(passed.reasons.join(), /the negative control drop-one passed validation/);
  const caught = classify({ ...run({ failures: ["attention: missing 1 x item"] }), candidateMutation: "drop-one" }).s;
  assert.doesNotMatch(caught.reasons.join(), /negative control/);
});

test("a paired ratio compares the sides round by round, so load that moves both cancels", () => {
  const value = run();
  // One slow round for both sides: the pooled medians move, the ratio does not.
  for (const child of value.children.filter(item => item.round === 9)) child.samplesNs = child.samplesNs.map(sample => sample * 50);
  const paired = pairedRatios(value.children);
  assert.equal(paired.rounds, 10);
  assert.equal(paired.median, 0.655);
  assert.equal(paired.min, 0.655);
  assert.match(renderReport(value), /Paired by round, candidate median \/ baseline median: 0\.655 \(range 0\.655\.\.0\.655 over 10 rounds\)/);
  value.children[0] = { ...value.children[0], error: "baseline child failed", samplesNs: [] };
  assert.equal(pairedRatios(value.children).rounds, 9);
});

test("a recorded run renders its report again from run.json", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "acc-measure-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "run.json"), value = run();
  await writeFile(file, JSON.stringify(value));
  const script = path.resolve(import.meta.dirname, "..", "..", "scripts", "measure", "report.mjs");
  const child = await runProcess([script, file], { timeoutMs: 60_000 });
  assert.equal(child.code, 0, child.stderr);
  assert.equal(child.stdout, `${renderReport(value)}\n`);
});

test("the report labels each figure and names a tail it cannot support", () => {
  const text = renderReport({ ...run({ rounds: 2, samples: 5 }), host: { node: "v26.5.1", cpuModel: "test" },
    durability: { fsync: "real" } });
  assert.match(text, /\*\*smoke\*\*/);
  assert.match(text, /insufficient evidence/);
  assert.match(text, /diagnostic/i);
  assert.match(text, /receiptVisits/);
  assert.match(text, /fsync: real/);
});
