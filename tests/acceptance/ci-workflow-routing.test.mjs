// Workflow source contracts and actual checker/aggregate entry points stay together
// so scheduling, input safety and their executed gates cannot drift apart.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

const shouldRun = (block, ctx) => {
  const indentation = block.startsWith("    ") ? "    " : "        ";
  const expression = block.match(new RegExp(`^${indentation}if: (.+)$`, "m"))?.[1];
  return expression === undefined || evaluate(expression.replace(/^\$\{\{|\}\}$/g, ""), ctx);
};

// Evaluate only the event filters used by these workflows. A skipped job still
// creates a check; an absent workflow event must not schedule any job at all.
function workflowRuns(source, ctx) {
  const triggers = source.match(/^on:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1];
  assert.ok(triggers, "workflow has no event boundary");
  const event = triggers.match(new RegExp(`^  ${ctx.github.event_name}:\\n([\\s\\S]*?)(?=^  \\w+:|$(?![\\s\\S]))`, "m"))?.[1];
  if (event === undefined) return false;
  if (ctx.github.event_name === "pull_request") return list(event, "types").includes(ctx.github.event.action);
  if (ctx.github.event_name === "push") return list(event, "branches").includes(ctx.github.ref.replace(/^refs\/heads\//, ""));
  throw new Error(`unsupported workflow event: ${ctx.github.event_name}`);
}
const workflowName = source => source.match(/^name: (.+)$/m)?.[1];
const jobIds = source => [...source.slice(source.indexOf("jobs:\n")).matchAll(/^  ([\w-]+):/gm)].map(match => match[1]);

test("workflow event boundaries keep Lint absent from edits and metadata required on every PR action", async () => {
  const lintSource = await workflow("lint");
  assert.deepEqual(list(lintSource, "types"), ["opened", "synchronize", "reopened"],
    "Lint must exclude edited at the workflow event boundary");
  const metadataSource = await workflow("pr-metadata");
  assert.deepEqual(list(metadataSource, "types"), ["opened", "synchronize", "reopened", "edited"],
    "metadata must include description edits");
  assert.deepEqual(list(lintSource, "branches"), ["main"]);
  assert.doesNotMatch(metadataSource, /^  (?:push|pull_request_target|workflow_dispatch):/m);
  for (const source of [lintSource, metadataSource]) {
    assert.doesNotMatch(source, /pull_request_target|^\s+permissions:|^\s+paths(?:-ignore)?:/m);
  }
  assert.equal(workflowName(lintSource), "Lint");
  assert.equal(workflowName(metadataSource), "PR metadata");
  assert.deepEqual(jobIds(lintSource), ["Lint"]);
  assert.deepEqual(jobIds(metadataSource), ["pr-metadata"]);
  const metadata = job(metadataSource, "pr-metadata");
  const lint = job(lintSource, "Lint");
  assert.equal(scalar(metadata, "name"), "PR metadata");
  assert.equal(lint.match(/^    name: (.+)$/m)?.[1] ?? "Lint", "Lint");
  for (const block of [metadata, lint]) assert.doesNotMatch(block, /^    (?:if|needs):|continue-on-error:/m);
  for (const action of ["opened", "synchronize", "reopened", "edited"]) {
    const ctx = context("pull_request", action);
    assert.equal(workflowRuns(lintSource, ctx), action !== "edited", action);
    assert.equal(workflowRuns(metadataSource, ctx), true, action);
    assert.equal(shouldRun(metadata, ctx), true, action);
  }
  const push = context("push", undefined, "refs/heads/main");
  assert.equal(workflowRuns(lintSource, push), true);
  assert.equal(workflowRuns(metadataSource, push), false);
  assert.equal(workflowRuns(lintSource, context("push", undefined, "refs/heads/other")), false);
});

test("PR metadata passes hostile description bytes as data to the actual checker", async t => {
  const metadata = job(await workflow("pr-metadata"), "pr-metadata");
  const steps = metadata.split(/^      - /m).slice(1);
  const body = steps.find(step => step.includes("--text-env PR_BODY"));
  assert.ok(body, "metadata must invoke the existing text-env checker");
  const commands = [...metadata.matchAll(/^        run: (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(commands, ["node scripts/check-commit-attribution.mjs --text-env PR_BODY"]);
  assert.equal(scalar(body, "PR_BODY"), "${{ github.event.pull_request.body }}");
  for (const action of ["opened", "synchronize", "reopened", "edited"]) {
    assert.equal(shouldRun(body, context("pull_request", action)), true, action);
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "acc-metadata-body-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sentinel = path.join(temporary, "executed");
  const shellLooking = `quotes ' "\n$(touch '${sentinel}')\n\`touch '${sentinel}'\``;
  for (const [description, code] of [["A clean description", 0], ["", 0],
    ["Claude-Session: https://claude.ai/code/session_fixture", 1], [shellLooking, 0]]) {
    const ctx = context("pull_request", "edited");
    ctx.github.event.pull_request = { body: description };
    assert.equal(shouldRun(body, ctx), true);
    const env = { ...process.env, PR_BODY: interpolate(scalar(body, "PR_BODY"), ctx) };
    assert.equal(env.PR_BODY, description);
    const [, ...args] = commands[0].split(" ");
    const result = await run(process.execPath, args, { cwd: repo, env }).then(
      () => 0, error => error.code);
    assert.equal(result, code, description);
  }
  await assert.rejects(access(sentinel), { code: "ENOENT" });
});

test("code Lint retains unconditional syntax and complete history while descriptions are metadata-only", async () => {
  const source = await workflow("lint");
  const lint = job(source, "Lint");
  const steps = lint.split(/^      - /m).slice(1);
  const syntax = steps.find(step => step.includes("run: node scripts/check-syntax.mjs --tracked"));
  const history = steps.find(step => step.includes("run: node scripts/check-commit-attribution.mjs --history HEAD"));
  assert.ok(syntax, "Lint must validate tracked syntax");
  assert.ok(history, "Lint must validate complete commit history");
  assert.equal(scalar(lint, "fetch-depth"), "0");
  assert.deepEqual([...lint.matchAll(/^        run: (.+)$/gm)].map(match => match[1]), [
    "node scripts/check-syntax.mjs --tracked",
    "node scripts/check-commit-attribution.mjs --history HEAD",
  ]);
  assert.doesNotMatch(lint, /PR_BODY|--text-env|pull_request\.body/);
  for (const ctx of [context("pull_request", "opened"), context("pull_request", "synchronize"),
    context("pull_request", "reopened"), context("push", undefined, "refs/heads/main")]) {
    assert.equal(workflowRuns(source, ctx), true);
    assert.equal(shouldRun(lint, ctx), true);
    assert.equal(shouldRun(syntax, ctx), true);
    assert.equal(shouldRun(history, ctx), true);
  }
});

test("each workflow coalesces its own stale PR runs without cross-workflow cancellation", async () => {
  const groups = [];
  for (const [name, expectedName] of [["ci", "CI"], ["lint", "Lint"], ["pr-metadata", "PR metadata"]]) {
    const source = await workflow(name);
    assert.equal(workflowName(source), expectedName);
    const group = scalar(source, "group");
    const key = action => interpolate(group, context("pull_request", action,
      "refs/pull/12/merge", workflowName(source)));
    assert.equal(key("opened"), key("synchronize"));
    assert.equal(key("reopened"), key("synchronize"));
    assert.notEqual(key("opened"), interpolate(group,
      context("pull_request", "opened", "refs/pull/13/merge", workflowName(source))));
    assert.equal(evaluate(scalar(source, "cancel-in-progress"), {}), true);
    if (name === "pr-metadata") assert.equal(key("edited"), key("synchronize"));
    groups.push(key(name === "pr-metadata" ? "edited" : "synchronize"));
  }
  assert.equal(new Set(groups).size, 3, "metadata edits must not cancel code Lint or CI");
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
  for (const [id, , os, workers, runner = os] of lanes) {
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
        assert.equal(scalar(block, "runs-on"), runner);
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
    // Raw expression evaluation omits Actions' default success() status check.
    assert.match(scalar(block, "if"), /^\$\{\{\s*always\(\)\s*\}\}$/,
      `${id} must explicitly run after failed or skipped dependencies`);
    const needs = successfulNeeds(route, plan, workers);
    const scheduledNeeds = Object.fromEntries(list(block, "needs").map(key => [key, needs[key]]));
    const input = { route, plan, runAttempt: "1", platform: scalar(block, "CI_PLATFORM"), needs: scheduledNeeds };
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
    ["real-clients", ["ubuntu-latest", "windows-latest"], ["npm ci", "node scripts/ci-real-clients.mjs"]],
  ]) {
    const block = job(source, id);
    assert.equal(scalar(block, "name"), `${id === "package" ? "package" : "real clients"} · \${{ matrix.os }}`);
    assert.deepEqual(scalar(block, "os").slice(1, -1).split(/,\s*/), platforms);
    assert.equal(scalar(block, "fail-fast"), "false");
    assert.equal(scalar(block, "needs"), "plan");
    assert.match(scalar(block, "if"), /^\$\{\{\s*always\(\)\s*\}\}$/,
      `${id} must explicitly authenticate after planner failure`);
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
      assert.equal(scalar(block, "timeout-minutes"), "30");
      const uploads = block.split(/^      - /m).filter(step => step.includes("actions/upload-artifact@"));
      assert.equal(uploads.length, 1);
      assert.equal(scalar(uploads[0], "if"), "${{ always() }}");
      assert.equal(scalar(uploads[0], "if-no-files-found"), "error");
      assert.equal(scalar(uploads[0], "path"), "${{ runner.temp }}/acc-client-compatibility/");
      assert.match(scalar(uploads[0], "name"), /\$\{\{ matrix.os \}\}.*\$\{\{ github.run_id \}\}.*\$\{\{ github.run_attempt \}\}/);
      assert.ok(block.indexOf("actions/upload-artifact@") > preflights[1].index);
      assert.doesNotMatch(block, /continue-on-error:|\$\{\{.*inputs\./);
      for (const step of block.split(/^      - /m).filter(step => !step.startsWith("name: Prepare Linux Codex sandbox\n"))) {
        assert.doesNotMatch(step, /shell: bash/);
      }
    }
  }
});

test("latest compatibility is an independent manual-only two-platform workflow", async () => {
  const source = await workflow("client-compatibility");
  assert.match(source, /^name: Client compatibility \(latest\)$/m);
  assert.match(source, /^on:\n  workflow_dispatch:\s*\n/m);
  assert.doesNotMatch(source, /^  (?:push|pull_request|schedule|release|inputs):|continue-on-error:|CI_ROUTE:|preflight|\$\{\{.*inputs\./m);
  const block = job(source, "latest-clients");
  assert.equal(scalar(block, "name"), "latest client compatibility · ${{ matrix.os }}");
  assert.deepEqual(list(block, "os"), ["ubuntu-latest", "windows-latest"]);
  assert.equal(scalar(block, "fail-fast"), "false");
  assert.equal(scalar(block, "timeout-minutes"), "30");
  assert.equal(scalar(block, "fetch-depth"), "0");
  assert.equal(scalar(block, "node-version"), "'24'");
  const ordinarySteps = block.split(/^      - /m).filter(step => !step.startsWith("name: Prepare Linux Codex sandbox\n")).join("\n");
  assert.doesNotMatch(ordinarySteps, /shell: bash/);
  assert.deepEqual([...ordinarySteps.matchAll(/^        run: (.+)$/gm)].map(match => match[1]), ["node scripts/ci-real-clients.mjs"]);
  assert.match(block, /- run: npm ci/);
  const upload = block.split(/^      - /m).find(step => step.includes("actions/upload-artifact@"));
  assert.equal(scalar(upload, "if"), "${{ always() }}");
  assert.equal(scalar(block, "if-no-files-found"), "error");
  assert.equal(scalar(block, "path"), "${{ runner.temp }}/acc-client-compatibility/");
  assert.match(scalar(block, "name"), /^latest client compatibility/);
});

test("both compatibility lanes prepare Linux namespaces before the complete driver workload", async () => {
  const expected = [
    "sudo apt-get update",
    "sudo apt-get install --yes bubblewrap apparmor-profiles apparmor-utils",
    "if test -f /usr/share/apparmor/extra-profiles/bwrap-userns-restrict; then",
    "  sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict",
    "fi",
    "if test -f /etc/apparmor.d/bwrap-userns-restrict; then",
    "  sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict",
    "fi",
    "command -v bwrap",
    "bwrap --version",
    "dpkg-query -W bubblewrap apparmor-profiles apparmor-utils",
    "bwrap --unshare-user --unshare-net --ro-bind / / /bin/true",
  ].join("\n");
  for (const [name, id] of [["ci", "real-clients"], ["client-compatibility", "latest-clients"]]) {
    const block = job(await workflow(name), id);
    const steps = block.split(/^      - /m).slice(1);
    const setups = steps.filter(step => step.startsWith("name: Prepare Linux Codex sandbox\n"));
    assert.equal(setups.length, 1, `${name} must prepare the Linux sandbox exactly once`);
    const setup = setups[0];
    assert.equal(scalar(setup, "shell"), "bash");
    assert.equal(scalar(setup, "if"), "runner.os == 'Linux'");
    assert.equal(shouldRun(setup, { runner: { os: "Linux" } }), true);
    assert.equal(shouldRun(setup, { runner: { os: "Windows" } }), false);
    const commands = setup.split("        run: |\n")[1]?.trimEnd().replace(/^          /gm, "");
    assert.equal(commands, expected, `${name} must retain the ordinary-user namespace probe and distribution profile`);
    assert.ok(block.indexOf("- run: npm ci") < block.indexOf("name: Prepare Linux Codex sandbox"));
    assert.ok(block.indexOf("name: Prepare Linux Codex sandbox") < block.indexOf("run: node scripts/ci-real-clients.mjs"));
    assert.doesNotMatch(block, /sysctl|apparmor_restrict_unprivileged_userns|unprivileged_userns_clone/);
  }
});
