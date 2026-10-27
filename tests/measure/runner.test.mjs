import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "../helpers/run-process.mjs";

// #304: a comparison alternates its sides, keeps what makes two runs
// comparable, and says what its evidence supports. Both sides are this
// checkout here, so the suite needs no install. GIT_DIR='' is what CI and the
// suite export to keep fixture repositories off this checkout.
const runner = path.resolve(import.meta.dirname, "..", "..", "scripts", "measure", "run.mjs");

// The runner's own temporary directory, so what its children leave behind is its own,
// whatever else runs on the machine.
async function runnerTemp(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "acc-measure-tmp-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return { directory, env: { GIT_DIR: "", TMPDIR: directory, TEMP: directory, TMP: directory } };
}
const childDirectories = async directory => (await readdir(directory)).filter(name => name.startsWith("acc-measure-child-"));

async function measure(t, args) {
  const out = await mkdtemp(path.join(tmpdir(), "acc-measure-run-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const temp = await runnerTemp(t);
  const child = await runProcess([runner, ...args, "--baseline", "worktree", "--candidate", "worktree",
    "--out", out], { timeoutMs: 120_000, env: temp.env });
  return { child, out, temp: temp.directory, run: JSON.parse(await readFile(path.join(out, "run.json"), "utf8").catch(() => "null")),
    report: await readFile(path.join(out, "report.md"), "utf8").catch(() => "") };
}

test("a short attention comparison alternates its sides and records what makes it comparable", async t => {
  const { child, run, report } = await measure(t, ["--probe", "attention", "--set", "ownRequests=20",
    "--set", "fanout=2", "--vary", "inboundObligations=4,8", "--rounds", "2", "--samples", "3", "--warmup", "1"]);
  assert.equal(child.code, 0, child.stderr);
  assert.equal(run.scenarios.length, 2);
  assert.equal(run.children.length, 2 * 2 * 2);
  assert.deepEqual(run.children.filter(item => item.round === 1).map(item => item.side).slice(0, 1), ["candidate"]);
  for (const side of ["baseline", "candidate"]) {
    assert.match(run.sides[side].commit, /^[0-9a-f]{40}$/);
    assert.match(run.sides[side].sourcesHash, /^[0-9a-f]{64}$/);
    assert.equal(typeof run.sides[side].dirty, "boolean");
  }
  for (const key of ["node", "v8", "os", "release", "arch", "cpuModel", "cores", "memoryBytes"]) {
    assert.ok(run.host[key] !== undefined, key);
  }
  assert.match(run.harness.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof run.harness.dirty, "boolean");
  assert.equal(run.durability.fsync, "real");
  assert.doesNotMatch(run.durability.nodeOptions, /test-skip-fsync/);
  for (const item of run.children) {
    assert.deepEqual(item.validation, []);
    assert.equal(item.samplesNs.length, 3);
    assert.equal(item.loadBefore.length, 3);
    assert.match(item.fixtureDigest, /^[0-9a-f]{64}$/);
  }
  assert.match(report, /\*\*smoke\*\*/);
  assert.match(report, /insufficient evidence/);
  assert.match(report, new RegExp(run.sides.baseline.sourcesHash));
});

test("a store probe runs in the same way, with durability as asked", async t => {
  const { child, run } = await measure(t, ["--probe", "transaction", "--set", "messages=4", "--set", "events=12",
    "--rounds", "2", "--samples", "2", "--warmup", "1", "--fsync", "skipped"]);
  assert.equal(child.code, 0, child.stderr);
  assert.equal(run.durability.fsync, "skipped");
  assert.match(run.durability.nodeOptions, /--import file:/);
  assert.ok(run.children.every(item => item.validation.length === 0), JSON.stringify(run.children.map(item => item.validation)));
  assert.ok(run.children.every(item => item.observations.enumerations !== undefined));
});

test("a candidate that skips work makes the comparison invalid", async t => {
  const { child, run, report } = await measure(t, ["--probe", "attention", "--set", "ownRequests=20",
    "--rounds", "1", "--samples", "2", "--warmup", "1", "--candidate-mutation", "drop-one"]);
  assert.equal(child.code, 1, child.stdout);
  assert.ok(run.children.some(item => item.side === "candidate" && item.validation.length > 0));
  assert.match(report, /\*\*invalid\*\*: candidate failed validation/);
});

test("repeated --vary runs every combination of the values in one run", async t => {
  const { child, run } = await measure(t, ["--probe", "attention", "--set", "inboundObligations=2",
    "--vary", "ownRequests=10,20", "--vary", "fanout=1,2", "--rounds", "1", "--samples", "1", "--warmup", "0"]);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(run.scenarios.map(({ scenario }) => [scenario.ownRequests, scenario.fanout]),
    [[10, 1], [10, 2], [20, 1], [20, 2]]);
  assert.equal(run.children.length, 4 * 2);
});

test("a runner stopped by SIGINT ends its child and removes its directory",
  { skip: process.platform === "win32" && "Windows ends a process without running its signal handlers" }, async t => {
    const out = await mkdtemp(path.join(tmpdir(), "acc-measure-run-"));
    t.after(() => rm(out, { recursive: true, force: true }));
    const temp = await runnerTemp(t);
    const runnerProcess = spawn(process.execPath, [runner, "--probe", "attention", "--set", "ownRequests=3000",
      "--rounds", "4", "--samples", "200", "--baseline", "worktree", "--candidate", "worktree", "--out", out],
    { env: { ...process.env, ...temp.env }, stdio: "ignore" });
    const exited = once(runnerProcess, "exit");
    // Its first child has started once its directory exists.
    for (const end = Date.now() + 60_000; (await childDirectories(temp.directory)).length === 0;) {
      assert.ok(Date.now() < end, "the runner never started a child");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    runnerProcess.kill("SIGINT");
    const [code] = await exited;
    assert.equal(code, 130);
    assert.deepEqual(await childDirectories(temp.directory), []);
  });

test("a scenario named twice is refused, since its children would pool", async t => {
  const { child, run } = await measure(t, ["--probe", "attention", "--vary", "seed=1,1", "--rounds", "1",
    "--samples", "1", "--warmup", "0"]);
  assert.equal(child.code, 2, child.stdout);
  assert.match(child.stderr, /name the same scenario twice/);
  assert.equal(run, null);
});

test("a scenario too small for its calls is refused before anything runs", async t => {
  const { child, run } = await measure(t, ["--probe", "inbox", "--set", "operation=exact", "--set", "messages=3",
    "--set", "backlog=0", "--rounds", "1", "--samples", "5", "--warmup", "1"]);
  assert.equal(child.code, 2, child.stdout);
  assert.match(child.stderr, /needs 7 calls, and the scenario allows 3/);
  assert.equal(run, null);
});

test("a child that fails or overruns is recorded, the run is still written, and it is invalid", async t => {
  const { child, run, report, temp } = await measure(t, ["--probe", "attention", "--set", "ownRequests=20",
    "--rounds", "1", "--samples", "2", "--warmup", "1", "--timeout-ms", "1"]);
  assert.equal(child.code, 1, child.stdout);
  assert.equal(run.children.length, 2);
  assert.ok(run.children.every(item => /timed out/.test(item.error)), JSON.stringify(run.children));
  assert.match(report, /\*\*invalid\*\*/);
  assert.match(report, /timed out/);
  // Each child's temporary directory goes with it, killed or not.
  assert.deepEqual(await childDirectories(temp), []);
});

test("a child that crashes records its cause and the failures it had already found", async t => {
  // Two messages per call run the fixture out on the third call.
  const { child, run, report } = await measure(t, ["--probe", "inbox", "--set", "operation=exact", "--set", "messages=4",
    "--set", "backlog=0", "--rounds", "1", "--samples", "2", "--warmup", "1", "--fsync", "skipped",
    "--candidate-mutation", "wrong-message"]);
  assert.equal(child.code, 1, child.stdout);
  const candidate = run.children.find(item => item.side === "candidate");
  assert.match(candidate.error, /candidate child failed: TypeError/);
  assert.ok(candidate.validation.length > 0, JSON.stringify(candidate));
  assert.equal(run.children.find(item => item.side === "baseline").error, undefined);
  assert.match(report, /candidate child failed/);
});
