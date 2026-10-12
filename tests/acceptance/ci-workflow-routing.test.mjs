import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";

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
  return evaluate(value, {});
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

test("the Windows matrix runs every discovered test exactly once", async () => {
  const source = await workflow("ci");
  const shards = job(source, "windows-shards");
  const command = shards.match(/^        run: (npm test.*)$/m)?.[1];
  assert.ok(command, "missing Windows test invocation");
  const discovered = async args => {
    const { stdout } = await run(process.execPath, ["scripts/run-tests.mjs", ...args, "--list"],
      { cwd: repo });
    return stdout.split(/\r?\n/).filter(line => line.endsWith(".test.mjs")).sort();
  };
  const all = await discovered([]);
  const selected = [];
  for (const shard of list(shards, "shard")) {
    const rendered = interpolate(command, { matrix: { shard } });
    const args = rendered.replace(/^npm test --\s+/, "").trim().split(/\s+/);
    const files = await discovered(args);
    assert.ok(files.length > 0 && files.length < all.length, rendered);
    selected.push(...files);
  }
  assert.equal(new Set(selected).size, selected.length, "duplicate Windows test selection");
  assert.deepEqual(selected.sort(), all, "Windows matrix omits discovered test files");
  const platforms = list(job(source, "test"), "os");
  assert.deepEqual([...platforms].sort(), ["macos-latest", "ubuntu-latest"]);
});

test("the existing Windows required check rejects unsuccessful shard results", async () => {
  const aggregate = job(await workflow("ci"), "windows-test");
  assert.equal(scalar(aggregate, "name"), "windows-latest · node 24");
  assert.equal(scalar(aggregate, "needs"), "windows-shards");
  assert.equal(evaluate(scalar(aggregate, "if").replace(/^\$\{\{|\}\}$/g, ""),
    { always: () => true }), true);
  const code = aggregate.match(/run: node --input-type=module -e "([^"]+)"/)?.[1];
  assert.ok(code, "missing executable shard-result gate");
  const envExpression = scalar(aggregate, "SHARD_RESULT").replace(/^\$\{\{|\}\}$/g, "");
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const env = { ...process.env, SHARD_RESULT: evaluate(envExpression,
      { needs: { "windows-shards": { result } } }) };
    const outcome = await run(process.execPath, ["--input-type=module", "-e", code], { env })
      .then(() => 0, error => error.code);
    assert.equal(outcome, result === "success" ? 0 : 1, result);
  }
});
