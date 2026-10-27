import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "../helpers/run-process.mjs";

// #304: a comparison alternates its sides, keeps what makes two runs
// comparable, and says what its evidence supports. Both sides are this
// checkout here, so the suite needs no install. GIT_DIR='' is what CI and the
// suite export to keep fixture repositories off this checkout.
const runner = path.resolve(import.meta.dirname, "..", "..", "scripts", "measure", "run.mjs");

async function measure(t, args) {
  const out = await mkdtemp(path.join(tmpdir(), "acc-measure-run-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const child = await runProcess([runner, ...args, "--baseline", "worktree", "--candidate", "worktree",
    "--out", out], { timeoutMs: 120_000, env: { GIT_DIR: "" } });
  return { child, out, run: JSON.parse(await readFile(path.join(out, "run.json"), "utf8").catch(() => "null")),
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
  assert.equal(run.durability.fsync, "real");
  for (const item of run.children) {
    assert.deepEqual(item.validation, []);
    assert.equal(item.samplesNs.length, 3);
    assert.equal(item.loadBefore.length, 3);
    assert.match(item.fixtureDigest, /^[0-9a-f]{64}$/);
  }
  assert.match(report, /\*\*smoke\*\*/);
  assert.match(report, /insufficient evidence/);
});

test("a store probe runs in the same way, with durability as asked", async t => {
  const { child, run } = await measure(t, ["--probe", "transaction", "--set", "messages=4", "--set", "events=12",
    "--rounds", "2", "--samples", "2", "--warmup", "1", "--fsync", "skipped"]);
  assert.equal(child.code, 0, child.stderr);
  assert.equal(run.durability.fsync, "skipped");
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
