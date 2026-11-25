import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PATHS, childCpuMs, measure, measured, percentile, renderTable, summarize }
  from "../../scripts/measure/cold-start.mjs";

test("CPU time is the children line of times, in bash and in dash format", () => {
  assert.deepEqual(childCpuMs("0m0.003s 0m0.004s\n0m0.120s 0m0.035s\n"),
    { userMs: 120, systemMs: 35, cpuMs: 155 });
  const dash = childCpuMs("0m0.000000s 0m0.001000s\n1m2.500000s 0m0.250000s\n");
  assert.equal(dash.userMs, 62_500);
  assert.equal(dash.systemMs, 250);
  // The shell's own line alone is not the measured process.
  assert.throws(() => childCpuMs("0m0.003s 0m0.004s\n"), /no child line/);
});

test("percentiles take the sample at or above the fraction, never past the end", () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile(values, 0.5), 10);
  assert.equal(percentile(values, 0.95), 19);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([], 0.5), null);
  const summary = summarize(values.map(value => ({ wallMs: value * 100, cpuMs: value })));
  assert.equal(summary.wallMs.p95, 1900);
  assert.equal(summary.p95ShareOfHookBudget, 0.38);
  assert.equal(summary.cpuMs.max, 20);
});

// One real round: every path runs to completion in an isolated project, and
// each sample has a wall time and a CPU time.
test("one round measures every hook path and inbox of the checkout", {
  skip: process.platform === "win32" ? "CPU time comes from a POSIX shell" : false,
}, async () => {
  const run = await measure({ packageRoot: path.resolve(import.meta.dirname, "..", ".."),
    rounds: 1, warmup: 0 });

  for (const name of PATHS) {
    const [sample] = run.samples[name];
    assert.equal(run.samples[name].length, 1, name);
    assert.ok(sample.wallMs > 0 && sample.cpuMs > 0, `${name}: ${JSON.stringify(sample)}`);
  }
  assert.equal(run.hookBudgetMs, 5_000);
  assert.match(renderTable(run.summary), /\| guard \| 1 \|/);
});

test("a command that exits without reading its input is measured, not failed by EPIPE",
  { skip: process.platform === "win32" ? "measured runs a POSIX shell" : false }, async t => {
  // More input than a pipe holds, to a command that never reads it: the write
  // can only finish after the command has exited, which is the EPIPE a loaded
  // runner hit with `node -e 0` and a few bytes.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cold-epipe-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(cwd);

  const run = await measured("/bin/sh", ["-c", "exit 0"],
    { cwd, env: { PATH: "/usr/bin:/bin" }, input: "x".repeat(1 << 20) });

  assert.equal(typeof run.wallMs, "number");
});
