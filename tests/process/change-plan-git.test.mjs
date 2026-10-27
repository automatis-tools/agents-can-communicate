import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture as pushFixture, invokePush, refLine, cleanEnv } from "../helpers/push-fixture.mjs";
import { run, source, event, git, put, commit, audit, fixture } from "../helpers/change-plan-fixture.mjs";
import * as planner from "../../scripts/change-plan.mjs";
import * as gitModule from "../../scripts/change-plan-git.mjs";

test("exact target tree supplies manifest and discovery despite divergent dirty checkout", async t => {
  assert.equal(typeof planner.createGatePlan, "function", "Git planner is not implemented");
  const { repo, base, target } = await fixture(t);
  await put(repo, "tests/docs/later-commit.test.mjs");
  await audit(repo);
  await commit(repo);
  await put(repo, "tests/docs/untracked.test.mjs");
  await put(repo, "scripts/validation-impact.json", "invalid checkout manifest");
  const plan = await planner.createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
  assert.equal(plan.scope, "docs");
  assert.equal(plan.targetCommit, target);
  assert.equal(plan.targetTree, await git(repo, "rev-parse", `${target}^{tree}`));
  assert.ok(plan.selectedFiles.includes("tests/docs/links.test.mjs"));
  assert.ok(!plan.selectedFiles.includes("tests/docs/untracked.test.mjs"));
  assert.ok(!plan.selectedFiles.includes("tests/docs/later-commit.test.mjs"));
  assert.ok(!plan.selectedFiles.includes("tests/runtime.test.mjs"));
  assert.ok(plan.requiredLanes.includes("package"));
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.selectedFiles));
  await planner.validateGatePlan(plan, { repo, discovery: [...plan.selectedFiles, "tests/runtime.test.mjs"].sort() });
  for (const patch of [{ selectedFiles: [] }, { scope: "full" }, { schema: 2 },
    { targetCommit: base }, { planDigest: "a".repeat(64) }, { requiredLanes: [] }, { baseTree: null }]) {
    await assert.rejects(planner.validateGatePlan({ ...plan, ...patch }, { repo }));
  }
  await assert.rejects(planner.validateGatePlan(plan, { repo, discovery: [] }));
  // A caller can calculate hashes too: recomputing a forged selection must not make it valid.
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const { planDigest, ...forged } = { ...plan, selectedFiles: ["tests/docs/links.test.mjs"] };
  forged.selectionDigest = hash(forged.selectedFiles);
  await assert.rejects(planner.validateGatePlan({ ...forged, planDigest: hash(canonical(forged)) }, { repo }), /plan-facts-mismatch/);

});

test("new reader source drift blocks later docs until explicitly audited", async t => {
  assert.equal(typeof planner.createGatePlan, "function");
  const { repo, target } = await fixture(t);
  await put(repo, "tests/new-reader.test.mjs", 'import { readFile } from "node:fs/promises"; await readFile("README.md");\n');
  const reader = await commit(repo);
  await put(repo, "README.md", "later docs\n");
  const next = await commit(repo);
  const plan = await planner.createGatePlan({ repo, baseCommit: reader, targetCommit: next, event });
  assert.equal(plan.scope, "full");
  assert.ok(plan.reasons.includes("reader-audit-drift"));
  assert.ok(plan.selectedFiles.includes("tests/new-reader.test.mjs"));
  const runtime = await planner.createGatePlan({ repo, baseCommit: target, targetCommit: reader, event });
  assert.equal(runtime.scope, "full");
});

test("unknown bases, empty diffs, nonancestor history and ambiguous/main/release events stay full", async t => {
  assert.equal(typeof planner.createGatePlan, "function");
  const { repo, base, target } = await fixture(t);
  for (const context of ["push", "release", { kind: "push", ref: "refs/heads/main" },
    { kind: "push", ref: "refs/tags/v1" }, { kind: "unknown" }]) {
    assert.equal((await planner.createGatePlan({ repo, baseCommit: base, targetCommit: target, event: context })).scope, "full");
  }
  for (const baseCommit of [null, "0".repeat(40), "f".repeat(40), target]) {
    assert.equal((await planner.createGatePlan({ repo, baseCommit, targetCommit: target, event })).scope, "full");
  }
  assert.equal((await planner.createGatePlan({ repo, baseCommit: target, targetCommit: base, event })).scope, "full");
  await assert.rejects(planner.createGatePlan({ repo, baseCommit: base, targetCommit: "HEAD", event }));
  await assert.rejects(planner.createGatePlan({ repo, baseCommit: base, targetCommit: "f".repeat(40), event }));
  await writeFile(path.join(repo, ".git", "shallow"), `${base}\n`);
  assert.equal((await planner.createGatePlan({ repo, baseCommit: base, targetCommit: target, event })).scope, "full");
});

test("raw-z parsing preserves spaces/newlines and refuses corrupt UTF-8 or malformed status", () => {
  assert.equal(typeof gitModule.parseRawChanges, "function", "raw Git parser is not implemented");
  const header = ':100644 100644 aaaaaaa bbbbbbb ';
  const records = gitModule.parseRawChanges(Buffer.from(`${header}R100\0docs/old name.md\0docs/new\nname.md\0`));
  assert.deepEqual(records, [{ status: "R", oldPath: "docs/old name.md", newPath: "docs/new\nname.md",
    oldMode: "100644", newMode: "100644" }]);
  for (const bytes of [Buffer.from(`${header}Q\0README.md\0`), Buffer.from(`${header}M\0README.md`),
    Buffer.concat([Buffer.from(`${header}M\0docs/`), Buffer.from([0xff]), Buffer.from('.md\0')])]) {
    assert.throws(() => gitModule.parseRawChanges(bytes));
  }
});

test("per-ref observation retains different bases and joins full before considering shared trees", async t => {
  const observer = await import("../../scripts/change-plan-observation.mjs").catch(() => ({}));
  assert.equal(typeof observer.observePushPlans, "function", "observer is not implemented");
  const { repo, base, target } = await fixture(t);
  const tree = await git(repo, "rev-parse", `${target}^{tree}`);
  const ref = (remoteRef, remoteOid) => ({ localRef: remoteRef, localOid: target, remoteRef, remoteOid });
  const report = await observer.observePushPlans(repo, [{ commit: target, tree, requiredScope: "full",
    refs: [ref("refs/heads/topic", base), ref("refs/heads/main", base), ref("refs/heads/new", "0".repeat(40))] }]);
  assert.equal(report.targets[0].scope, "full");
  assert.equal(report.targets[0].refs[0].plan.scope, "docs");
  assert.equal(report.targets[0].refs[1].plan.scope, "full");
  assert.equal(report.targets[0].refs[2].plan.baseTree, null);
  const unavailable = await observer.observePushPlans(repo, [{ commit: target, tree, requiredScope: "measurement-only",
    refs: [{ ...ref("refs/heads/measure/probe", base), localOid: "f".repeat(40) }] }]);
  assert.equal(unavailable.targets[0].scope, "full");
  assert.equal(unavailable.targets[0].executionScope, "measurement-only");
  assert.equal(unavailable.targets[0].refs[0].reason, "plan-unavailable");
});

test("CLI writes a validated exact-target plan atomically and preserves output on invalid input", async t => {
  assert.equal(typeof planner.createGatePlan, "function");
  const { repo, base, target } = await fixture(t);
  const output = path.join(repo, "plan.json");
  const command = path.join(source, "scripts/change-plan.mjs");
  await run(process.execPath, [command, "--base", base, "--target", target, "--event", "pr", "--output", output], { cwd: repo });
  const bytes = await readFile(output, "utf8");
  assert.equal(JSON.parse(bytes).scope, "docs");
  await assert.rejects(run(process.execPath, [command, "--base", base, "--target", "HEAD", "--event", "pr", "--output", output], { cwd: repo }));
  assert.equal(await readFile(output, "utf8"), bytes);
});

test("real Git renames, modes and new docs tests remain conservative without losing discovery", async t => {
  assert.equal(typeof planner.createGatePlan, "function");
  const { repo, target } = await fixture(t);
  await git(repo, "mv", "README.md", "docs name.md");
  let next = await commit(repo);
  assert.equal((await planner.createGatePlan({ repo, baseCommit: target, targetCommit: next, event })).scope, "full");
  await git(repo, "mv", "docs name.md", "README.md");
  let before = next; next = await commit(repo);
  assert.equal((await planner.createGatePlan({ repo, baseCommit: before, targetCommit: next, event })).scope, "full");
  await git(repo, "update-index", "--chmod=+x", "README.md");
  await git(repo, "-c", "core.hooksPath=", "commit", "-qm", "mode");
  before = next; next = await git(repo, "rev-parse", "HEAD");
  assert.equal((await planner.createGatePlan({ repo, baseCommit: before, targetCommit: next, event })).scope, "full");
  await git(repo, "update-index", "--chmod=-x", "README.md");
  await git(repo, "-c", "core.hooksPath=", "commit", "-qm", "restore mode");
  await put(repo, "tests/docs/new.test.mjs");
  await audit(repo);
  before = await commit(repo);
  await put(repo, "README.md", "new documentation\n");
  next = await commit(repo);
  const plan = await planner.createGatePlan({ repo, baseCommit: before, targetCommit: next, event });
  assert.equal(plan.scope, "docs");
  assert.ok(plan.selectedFiles.includes("tests/docs/new.test.mjs"));
});

test("PR validation merge verifies both exact base and requested head ancestry", async t => {
  assert.equal(typeof planner.createGatePlan, "function");
  const { repo, base, target } = await fixture(t);
  const good = await planner.createGatePlan({ repo, baseCommit: base, targetCommit: target,
    event: { kind: "pr", headCommit: target } });
  assert.equal(good.scope, "docs");
  const bad = await planner.createGatePlan({ repo, baseCommit: base, targetCommit: target,
    event: { kind: "pr", headCommit: "f".repeat(40) } });
  assert.equal(bad.scope, "full");
  await put(repo, "README.md", "future head\n");
  const future = await commit(repo);
  assert.equal((await planner.createGatePlan({ repo, baseCommit: base, targetCommit: target,
    event: { kind: "pr", headCommit: future } })).scope, "full");
});

test("broken optional observer cannot suppress a passing or failing full gate or measurement policy", async t => {
  const f = await pushFixture(t);
  const scripts = path.join(f.base, "driver");
  await cp(path.join(source, "scripts"), scripts, { recursive: true });
  await writeFile(path.join(scripts, "change-plan-observation.mjs"), "throw Error('observer failed');\n");
  const driver = path.join(scripts, "validate-push.mjs");
  const good = await invokePush(f, refLine(await f.oid()), driver);
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /observation unavailable/);
  assert.match(good.stdout, /actual target passed/);
  await writeFile(path.join(f.root, "target.test.mjs"), "throw Error('full gate still executes');\n");
  const bad = await f.commit("bad target");
  const failed = await invokePush(f, refLine(bad), driver);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stdout + failed.stderr, /full gate still executes/);
  const measurement = await invokePush(f, refLine(bad, "measure/probe"), driver);
  assert.equal(measurement.code, 0, measurement.stdout + measurement.stderr);
  assert.match(measurement.stdout, /measurement-only.*no suite/);
});

test("unrelated history, a failed diff and malformed manifest force complete selection", async t => {
  const { repo, base, target } = await fixture(t);
  const tree = await git(repo, "rev-parse", `${target}^{tree}`);
  const unrelated = await git(repo, "commit-tree", tree, "-m", "unrelated root");
  const full = await planner.createGatePlan({ repo, baseCommit: unrelated, targetCommit: target, event });
  assert.equal(full.scope, "full");
  assert.ok(full.selectedFiles.includes("tests/runtime.test.mjs"));
  await git(repo, "config", "diff.algorithm", "invalid-algorithm");
  const failed = await planner.createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
  assert.equal(failed.scope, "full");
  assert.ok(failed.reasons.includes("history-incomplete"));
  await git(repo, "config", "--unset", "diff.algorithm");
  await put(repo, "scripts/validation-impact.json", '{"schema":1,"documentation":{}}');
  const bad = await commit(repo);
  const invalid = await planner.createGatePlan({ repo, baseCommit: target, targetCommit: bad, event });
  assert.equal(invalid.scope, "full");
  assert.ok(invalid.reasons.includes("manifest-unsupported"));
});

test("SHA-256 Git identities retain exact commit and tree identities", async t => {
  const { repo, base, target } = await fixture(t, "sha256");
  const plan = await planner.createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
  assert.equal(plan.scope, "docs");
  assert.equal(plan.targetCommit.length, 64);
  assert.equal(plan.targetTree.length, 64);
  await planner.validateGatePlan(plan, { repo });
});

test("tracked symlink/type change cannot be classified as ordinary Markdown", async t => {
  const { repo, base, target } = await fixture(t);
  const blob = await git(repo, "rev-parse", `${target}:README.md`);
  await git(repo, "update-index", "--cacheinfo", `120000,${blob},README.md`);
  await git(repo, "-c", "core.hooksPath=", "commit", "-qm", "type change");
  const next = await git(repo, "rev-parse", "HEAD");
  assert.equal((await planner.createGatePlan({ repo, baseCommit: base, targetCommit: next, event })).scope, "full");
});

test("invalid UTF-8 Git filenames yield unavailable observation with a full fallback", async t => {
  const { repo, target } = await fixture(t);
  // Build the raw Git object: APFS refuses invalid UTF-8 filesystem names.
  const existing = (await run("git", ["-C", repo, "ls-tree", "-z", target], { encoding: "buffer", env: cleanEnv() })).stdout;
  const blob = await git(repo, "rev-parse", `${target}:README.md`);
  const treeResult = spawnSync("git", ["-C", repo, "mktree", "-z"], { input: Buffer.concat([
    existing, Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff]), Buffer.from(".md\0")]), encoding: "utf8", env: cleanEnv() });
  assert.equal(treeResult.status, 0, treeResult.stderr);
  const next = await git(repo, "commit-tree", treeResult.stdout.trim(), "-p", target, "-m", "invalid filename");
  const { observePushPlans } = await import("../../scripts/change-plan-observation.mjs");
  const report = await observePushPlans(repo, [{ commit: next, tree: await git(repo, "rev-parse", `${next}^{tree}`),
    requiredScope: "full", refs: [{ localOid: next, remoteOid: target, remoteRef: "refs/heads/topic" }] }]);
  assert.equal(report.targets[0].scope, "full");
  assert.equal(report.targets[0].refs[0].reason, "plan-unavailable");
});
