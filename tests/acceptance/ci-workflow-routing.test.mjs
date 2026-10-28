import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { ciWorker, ciRouteDigest } from "../../scripts/ci-plan.mjs";
import { verifyCiAggregate } from "../../scripts/ci-results.mjs";
import { ciRunnerFixture } from "../helpers/ci-runner-fixture.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const workflow = name => readFile(path.join(repo, ".github", "workflows", `${name}.yml`), "utf8");
const evaluate = (expression, context) => vm.runInNewContext(expression, context);
const interpolate = (value, context) => value.replace(/\$\{\{(.*?)\}\}/g,
  (_, expression) => evaluate(expression, context));

// Read only the simple scalar/list blocks these workflows use. Unsupported or
// missing shapes fail here; actionlint separately validates full YAML/Actions syntax.
function job(source, id) {
  const block = source.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"));
  assert.ok(block, `missing ${id} job`);
  return block[1];
}
function scalar(source, key) {
  const value = source.match(new RegExp(`^\\s+${key}: (.+)$`, "m"))?.[1];
  assert.notEqual(value, undefined, `missing ${key}`);
  return value;
}
function list(source, key) {
  const value = scalar(source, key);
  assert.match(value, /^\[.*\]$/);
  return value.slice(1, -1).split(/,\s*/).map(item => item.replace(/^['"]|['"]$/g, ""));
}
const context = (event, action, ref = "refs/pull/12/merge", name = "Lint") => ({
  github: { event_name: event, event: { action }, ref, workflow: name },
});

test("description edits cannot replace failed syntax with a green attribution-only check", async () => {
  const lint = job(await workflow("lint"), "Lint");
  const steps = lint.split(/^      - /m).slice(1);
  const syntax = steps.find(step => step.includes("run: node scripts/check-syntax.mjs"));
  const history = steps.find(step => step.includes("--history HEAD"));
  const body = steps.find(step => step.includes("--text-env PR_BODY"));
  assert.ok(syntax && history && body);
  const shouldRun = (step, ctx) => {
    const expression = step.match(/^        if: (.+)$/m)?.[1];
    return expression === undefined || evaluate(expression.replace(/^\$\{\{|\}\}$/g, ""), ctx);
  };
  for (const action of ["opened", "synchronize", "reopened", "edited"]) {
    const ctx = context("pull_request", action);
    assert.equal(shouldRun(syntax, ctx), true, action);
    assert.equal(shouldRun(history, ctx), true, action);
    assert.equal(shouldRun(body, ctx), true, action);
  }
  const push = context("push", undefined, "refs/heads/main");
  assert.equal(shouldRun(syntax, push), true);
  assert.equal(shouldRun(history, push), true);
  assert.equal(shouldRun(body, push), false);
});

test("all stale PR runs coalesce because every Lint run validates the full gate", async () => {
  for (const name of ["ci", "lint"]) {
    const source = await workflow(name);
    const group = scalar(source, "group");
    const workflowName = name === "ci" ? "CI" : "Lint";
    const key = action => interpolate(group, context("pull_request", action,
      "refs/pull/12/merge", workflowName));
    assert.equal(key("opened"), key("synchronize"));
    assert.equal(key("reopened"), key("synchronize"));
    assert.notEqual(key("opened"), interpolate(group,
      context("pull_request", "opened", "refs/pull/13/merge", workflowName)));
    assert.equal(evaluate(scalar(source, "cancel-in-progress"), {}), true);
    assert.equal(key("edited"), key("synchronize"));
  }
});

const lanes = [
  ["linux-test", "linux", "ubuntu-latest", ["full-linux", "docs-linux"]],
  ["macos-test", "darwin", "macos-latest", ["full-macos", "docs-macos"]],
  ["windows-test", "win32", "windows-latest", ["full-windows-1", "full-windows-2", "docs-windows"]],
];
const condition = (block, ctx) => evaluate(scalar(block, "if").replace(/^\$\{\{|\}\}$/g, ""), ctx);
const hash = files => createHash("sha256").update(JSON.stringify(files)).digest("hex");
function successfulNeeds(route, plan, workers) {
  const needs = { plan: { result: "success", outputs: { route: JSON.stringify(route), scope: route.scope } } };
  for (const worker of workers) {
    const role = ciWorker(worker);
    const active = role.scope === route.scope;
    // Tiny synthetic completion proofs; the real aggregate independently checks
    // these selected files against the immutable plan. No test suite was run.
    const files = role.shard ? plan.selectedFiles.filter((_, i) => i % 2 === Number(role.shard[0]) - 1) : plan.selectedFiles;
    const proof = { schema: 1, workerId: worker, routeDigest: ciRouteDigest(route), runId: route.runId,
      runAttempt: route.runAttempt, targetCommit: route.targetCommit, targetTree: route.targetTree,
      planDigest: route.planDigest, scope: role.scope, platform: role.platform, node: "v24.4.0",
      shard: role.shard, fileCount: files.length, filesDigest: hash(files),
      concurrency: role.platform === "win32" ? 3 : 4, fsyncMode: "real", packageSmoke: role.scope === "docs" };
    needs[worker] = { result: active ? "success" : "skipped", outputs: active ? { proof: JSON.stringify(proof) } : {} };
  }
  return needs;
}

test("routing retains required identities and selects every planned worker without fail-fast coupling", async () => {
  const source = await workflow("ci");
  assert.doesNotMatch(source, /^\s+paths(?:-ignore)?:|pull_request_target|--if-needed/m);
  const planner = job(source, "plan");
  assert.match(planner, /run: node scripts\/ci-validation\.mjs plan/);
  assert.equal(scalar(planner, "route"), "${{ steps.route.outputs.route }}");
  assert.equal(scalar(planner, "scope"), "${{ steps.route.outputs.scope }}");
  for (const [id, , os, workers] of lanes) {
    const aggregate = job(source, id);
    assert.equal(scalar(aggregate, "name"), `${os} · node 24`);
    assert.deepEqual(list(aggregate, "needs"), ["plan", ...workers]);
    assert.equal(scalar(aggregate, "CI_NEEDS"), "${{ toJSON(needs) }}");
    assert.equal(scalar(aggregate, "CI_ROUTE"), "${{ needs.plan.outputs.route }}");
    assert.match(aggregate, /run: node scripts\/ci-validation\.mjs aggregate/);
    for (const scope of ["full", "docs", "", undefined]) {
      for (const worker of workers) {
        const block = job(source, worker);
        assert.equal(scalar(block, "needs"), "plan");
        assert.equal(scalar(block, "runs-on"), os);
        assert.equal(scalar(block, "timeout-minutes"), "30");
        assert.doesNotMatch(block, /strategy:|continue-on-error:/);
        assert.equal(condition(block, { needs: { plan: { outputs: { scope } } } }), ciWorker(worker).scope === scope);
        assert.equal(scalar(block, "worker"), worker);
        assert.equal(scalar(block, "artifact"), ciWorker(worker).artifactName);
        assert.equal(scalar(block, "route"), "${{ needs.plan.outputs.route }}");
        assert.equal(scalar(block, "proof"), "${{ steps.test.outputs.proof }}");
        assert.match(block, /uses: \.\/\.github\/actions\/ci-test/);
        const oldShard = worker.match(/^full-windows-([12])$/)?.[1];
        if (oldShard) assert.equal(scalar(block, "name"), `windows-latest · node 24 · shard ${oldShard}/2`);
      }
    }
  }
  const allJobs = source.slice(source.indexOf("jobs:\n")).split(/^  [\w-]+:\n/m).slice(1);
  assert.equal(allJobs.length, 13, "unexpected missing or extra scheduling roles");
  for (const block of allJobs) {
    assert.match(block, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
    assert.equal(scalar(block, "fetch-depth"), "0");
  }
});

test("planner logs the validated compact route without collecting raw event or environment", async () => {
  const planner = job(await workflow("ci"), "plan");
  const log = planner.split(/^      - /m).find(step => step.includes("name: Record authenticated route"));
  assert.ok(log);
  assert.equal(scalar(log, "CI_ROUTE"), "${{ steps.route.outputs.route }}");
  assert.equal(scalar(log, "continue-on-error"), "true");
  const command = scalar(log, "run").match(/^node --input-type=module -e "([^"]+)"$/)?.[1];
  assert.ok(command);
  const compact = JSON.stringify({ schema: 1, scope: "docs", runId: "1234" });
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", command],
    { env: { ...process.env, CI_ROUTE: compact, SECRET_SENTINEL: "must-not-be-collected" } });
  assert.equal(stdout, `CI_ROUTE=${compact}\n`);
});

test("the full Windows partitions exhaust real discovery without duplicate tests", async () => {
  const source = await workflow("ci");
  const discovered = async args => {
    const { stdout } = await run(process.execPath, ["scripts/run-tests.mjs", ...args, "--list"], { cwd: repo });
    return stdout.split(/\r?\n/).filter(line => line.endsWith(".test.mjs")).sort();
  };
  const all = await discovered([]);
  const selected = [];
  for (const worker of ["full-windows-1", "full-windows-2"]) {
    const role = ciWorker(scalar(job(source, worker), "worker"));
    const files = await discovered(["--shard", role.shard]);
    assert.ok(files.length > 0 && files.length < all.length);
    selected.push(...files);
  }
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.sort(), all);
});

for (const scope of ["docs", "full"]) test(`actual aggregate CLI fails closed for every ${scope} workflow dependency`, async t => {
  const f = await ciRunnerFixture(t, { scope });
  const planned = await f.invoke("plan");
  assert.equal(planned.code, 0, planned.stderr);
  const route = JSON.parse(planned.outputs.route);
  assert.equal(route.scope, scope);
  const plan = JSON.parse(await readFile(path.join(f.temporary, "acc-ci-plan.json"), "utf8"));
  const source = await workflow("ci");
  for (const [id, platform, , workers] of lanes) {
    const block = job(source, id);
    const needs = successfulNeeds(route, plan, workers);
    const scheduledNeeds = Object.fromEntries(list(block, "needs").map(key => [key, needs[key]]));
    const input = { route, plan, platform: scalar(block, "CI_PLATFORM"), needs: scheduledNeeds };
    assert.equal(input.platform, platform);
    assert.doesNotThrow(() => verifyCiAggregate(input));
    const invoke = async n => f.invoke("aggregate", { CI_ROUTE: planned.outputs.route,
      CI_PLATFORM: input.platform, CI_NEEDS: JSON.stringify(n) });
    assert.equal((await invoke(scheduledNeeds)).code, 0);
    for (const key of ["plan", ...workers.filter(w => w.startsWith(scope))]) {
      for (const result of ["failure", "cancelled", "skipped", ""]) {
        const broken = structuredClone(scheduledNeeds);
        broken[key].result = result;
        assert.equal(condition(block, { always: () => true, success: () => false, needs: broken }), true,
          `${id} must run after ${key} ${result}`);
        assert.throws(() => verifyCiAggregate({ ...input, needs: broken }), `${id}: ${key} ${result}`);
      }
      const absent = structuredClone(scheduledNeeds); delete absent[key];
      assert.throws(() => verifyCiAggregate({ ...input, needs: absent }));
      assert.notEqual((await invoke(absent)).code, 0);
    }
    for (const brokenPlan of [{}, { result: "success", outputs: {} }, { result: "success", outputs: { route: "{}" } }]) {
      assert.notEqual((await invoke({ ...scheduledNeeds, plan: brokenPlan })).code, 0);
    }
    assert.notEqual((await invoke({})).code, 0, "empty aggregate cannot pass");
  }
});

test("package and client matrices preserve their workloads and authenticate before and after", async () => {
  const source = await workflow("ci");
  for (const [id, platforms, commands] of [
    ["package", ["ubuntu-latest", "macos-latest", "windows-latest"], ["npm ci", "node scripts/verify-package.mjs"]],
    ["real-clients", ["ubuntu-latest", "windows-latest"], ["npm ci", "npm install --global @anthropic-ai/claude-code @openai/codex",
      "claude --version", "codex --version", "node --test tests/acceptance/real-clients-stub.test.mjs",
      "python -m pip install --quiet pywinpty", "node --test tests/acceptance/real-claude-live-stub.test.mjs"]],
  ]) {
    const block = job(source, id);
    assert.equal(scalar(block, "name"), `${id === "package" ? "package" : "real clients"} · \${{ matrix.os }}`);
    assert.deepEqual(scalar(block, "os").slice(1, -1).split(/,\s*/), platforms);
    assert.equal(scalar(block, "fail-fast"), "false");
    assert.equal(scalar(block, "needs"), "plan");
    assert.equal(condition(block, { always: () => true, success: () => false }), true);
    assert.equal(scalar(block, "node-version"), "'24'");
    const preflights = [...block.matchAll(/run: node scripts\/ci-validation\.mjs preflight/g)];
    assert.equal(preflights.length, 2);
    for (const command of commands) {
      const position = block.indexOf(command);
      assert.ok(position > preflights[0].index && position < preflights[1].index, command);
    }
    for (const os of platforms) assert.equal(interpolate(scalar(block, "CI_WORKER"), { matrix: { os } }), `${id}-${os}`);
    assert.equal(scalar(block, "CI_ROUTE"), "${{ needs.plan.outputs.route }}");
    if (id === "real-clients") {
      assert.equal((block.match(/ACC_REAL_CLIENTS: '1'/g) ?? []).length, 2);
      assert.match(block, /if: runner.os == 'Windows'/);
    }
  }
});
