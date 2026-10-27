// Real ref bases, executed sentinels and exact target bytes protect routing.
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateGatePlan } from "../../scripts/change-plan.mjs";
import { parsePushRefs, resolvePushTrees } from "../../scripts/push-targets.mjs";
import { pushDocsFixture } from "../helpers/push-docs-fixture.mjs";
import { refLine } from "../helpers/push-fixture.mjs";

const passed = result => assert.equal(result.code, 0, result.stdout + result.stderr);
const refs = lines => parsePushRefs(lines.join("\n"), { objectFormat: "sha1" });

test("ordinary docs refs execute their docs selection, exact package smoke and docs-only reuse", async t => {
  const parentCI = process.env.CI;
  const f = await pushDocsFixture(t, { ci: false });
  assert.equal(process.env.CI, parentCI, "local fixture changed parent CI");
  const input = refLine(f.targetCommit, "docs", f.baseCommit);
  const first = await f.invoke(input); passed(first);
  assert.match(first.stdout, /documentation subset passed: 8 of 9 files/);
  assert.equal((await f.records("docs")).length, 1);
  assert.equal((await f.records("runtime")).length, 0);
  assert.equal((await f.records("smoke")).length, 1);
  assert.equal((await f.records("packs")).length, 1);
  assert.equal((await f.records("docs"))[0].cwd, await realpath(f.root));
  const planFile = first.stdout.match(/--selection-plan (.+?) --if-needed/)?.[1];
  assert.ok(planFile, "hook did not pass an explicit owned selection plan");
  assert.equal(path.relative(f.root, planFile).startsWith(".."), true);
  assert.equal(await f.exists(path.dirname(planFile)), false, "external plan owner leaked after success");
  const second = await f.invoke(input); passed(second);
  assert.match(second.stdout, /test gate receipt: hit/);
  assert.match(second.stdout, /documentation gate: .*already passed/);
  assert.equal((await f.records("docs")).length, 1);
  assert.equal((await f.records("runtime")).length, 0);
  assert.equal((await f.records("smoke")).length, 1);
  assert.equal((await f.records("packs")).length, 1);
  // A docs proof cannot satisfy this identical tree's full main request.
  passed(await f.invoke(refLine(f.targetCommit, "main", f.baseCommit)));
  assert.equal((await f.records("runtime")).length, 1);
});

// Removing the runner's CI fingerprint guard must fail the no-proof assertions.
test("CI docs refs execute twice without persisting full or docs proof", async t => {
  const parentCI = process.env.CI;
  const f = await pushDocsFixture(t, { ci: true });
  const diagnostic = path.join(f.base, "ci-diagnostic.json");
  f.env.ACC_GATE_DIAGNOSTIC = diagnostic;
  const input = refLine(f.targetCommit, "docs", f.baseCommit);
  for (let count = 1; count <= 2; count++) {
    const result = await f.invoke(input); passed(result);
    assert.match(result.stdout, /--selection-plan .+ --if-needed/);
    assert.match(result.stdout, /test gate receipt: ci-disabled/);
    assert.doesNotMatch(result.stdout, /test gate receipt after run:/);
    const report = JSON.parse(await readFile(diagnostic, "utf8"));
    assert.deepEqual(report.receiptDecision, { reused: false, reason: "ci-disabled" });
    assert.equal(Object.hasOwn(report, "inputDigest"), false, "CI computed a reusable proof fingerprint");
    assert.deepEqual(report.events.filter(event => event.event === "fingerprint").map(event => event.result), ["ci-disabled"]);
    assert.equal(report.events.some(event => event.event === "receipt-persistence"), false, "CI attempted proof persistence");
    assert.equal((await f.records("docs")).length, count);
    assert.equal((await f.records("runtime")).length, 0);
    assert.equal((await f.records("smoke")).length, count);
    assert.equal((await f.records("packs")).length, count);
    assert.equal(process.env.CI, parentCI, "CI fixture changed parent CI");
  }
});

test("main, release, no-base and code refs require full; main executes the actual target", async t => {
  const f = await pushDocsFixture(t);
  await f.write("module.mjs", "export const code = true;\n");
  const code = await f.commit("code change");
  for (const [target, name, base] of [[f.targetCommit, "main", f.baseCommit],
    [f.targetCommit, "release/next", f.baseCommit], [f.targetCommit, "new-docs", undefined],
    [code, "docs", f.targetCommit]]) {
    const [classified] = await resolvePushTrees(f.root, refs([refLine(target, name, base)]), { planForRef: f.planForRef });
    assert.equal(classified.commit, target, name);
    assert.equal(classified.requiredScope, "full", name);
    assert.equal(classified.plan.targetCommit, target, name);
    await validateGatePlan(classified.plan, { repo: f.root });
  }
  const before = (await f.records("runtime")).length;
  const result = await f.invoke(refLine(f.targetCommit, "main", f.baseCommit)); passed(result);
  assert.match(result.stdout, /running actual target's full test suite/);
  assert.equal((await f.records("runtime")).length, before + 1);
  assert.equal((await f.records("smoke")).length, 0);
});

for (const reverse of [false, true]) {
  test(`same-tree joins preserve each base and the stronger representative (reverse=${reverse})`, async t => {
    const f = await pushDocsFixture(t);
    const alias = await f.commit("identical tree alias", true);
    const measurement = refLine(f.targetCommit, "measure/probe", f.baseCommit);
    const docs = refLine(alias, "docs", f.baseCommit);
    const ordered = values => reverse ? values.reverse() : values;
    const [joined] = await resolvePushTrees(f.root, refs(ordered([measurement, docs])), { planForRef: f.planForRef });
    assert.equal(joined.requiredScope, "docs"); assert.equal(joined.commit, alias);
    assert.equal(joined.plan.targetCommit, alias); assert.equal(joined.refs.length, 2);
    assert.equal(joined.refPlans.length, 2);
    passed(await f.invoke(ordered([measurement, docs]).join("\n")));
    assert.equal((await f.records("runtime")).length, 0);
    const full = refLine(f.targetCommit, "main", f.baseCommit);
    const [strong] = await resolvePushTrees(f.root, refs(ordered([docs, full])), { planForRef: f.planForRef });
    assert.equal(strong.requiredScope, "full"); assert.equal(strong.commit, f.targetCommit);
    assert.equal(strong.plan?.scope, "full");
    passed(await f.invoke(ordered([docs, full]).join("\n")));
    assert.equal((await f.records("runtime")).length, 1);
  });
}

test("each same-tree docs base is classified; failures and unknown facts cannot disappear", async t => {
  const f = await pushDocsFixture(t);
  const between = await f.git(["commit-tree", `${f.baseCommit}^{tree}`, "-p", f.baseCommit, "-m", "base alias"]);
  // Make both bases ancestors of a target with the same original target bytes.
  const aliasBase = between.stdout.trim();
  const target = (await f.git(["commit-tree", `${f.targetCommit}^{tree}`, "-p", f.targetCommit, "-p", aliasBase, "-m", "merge alias"])).stdout.trim();
  const lines = [refLine(target, "docs-a", f.baseCommit), refLine(target, "docs-b", aliasBase)];
  const seen = [];
  const [joined] = await resolvePushTrees(f.root, refs(lines), { planForRef: facts => {
    seen.push(facts); return f.planForRef(facts);
  } });
  assert.equal(joined.requiredScope, "docs"); assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(fact => fact.base), [f.baseCommit, aliasBase]);
  passed(await f.invoke(lines.join("\n"))); assert.equal((await f.records("runtime")).length, 0);
  for (const planForRef of [undefined, () => { throw Error("planner unavailable"); }, () => ({ scope: "docs" })]) {
    const [fallback] = await resolvePushTrees(f.root, refs(lines), { planForRef });
    assert.equal(fallback.requiredScope, "full");
  }
  await assert.rejects(resolvePushTrees(f.root, refs([lines[0], refLine(target, "other", "e".repeat(40))]),
    { planForRef: f.planForRef }), /unresolved remote base/);
  await assert.rejects(resolvePushTrees(f.root, [{ ...refs(lines)[0], remoteRef: "refs/heads/bad..name" }],
    { planForRef: f.planForRef }), /malformed push ref/);
  const [missing] = await resolvePushTrees(f.root, refs([lines[0], refLine(target, "no-base")]), { planForRef: f.planForRef });
  assert.equal(missing.requiredScope, "full");
  passed(await f.invoke([lines[0], refLine(target, "no-base")].join("\n")));
  assert.equal((await f.records("runtime")).length, 1);
});

test("tampered or ambiguous planner output retains full scope before joining", async t => {
  const f = await pushDocsFixture(t);
  const lines = refs([refLine(f.targetCommit, "docs", f.baseCommit)]);
  for (const edit of [plan => ({ ...plan, selectedFiles: [] }),
    plan => ({ ...plan, reasons: [...plan.reasons, "ref:refs/heads/other"] })]) {
    const [target] = await resolvePushTrees(f.root, lines, { planForRef: async facts => edit(await f.planForRef(facts)) });
    assert.equal(target.requiredScope, "full");
  }
});

test("ignored dirty input forces isolated docs execution without modifying current bytes or index", async t => {
  const f = await pushDocsFixture(t);
  await f.write("ignored.test.mjs", "throw Error('ignored current input must not execute');\n");
  const index = path.resolve(f.root, (await f.git(["rev-parse", "--git-path", "index"])).stdout.trim());
  const before = await readFile(index);
  const result = await f.invoke(refLine(f.targetCommit, "docs", f.baseCommit)); passed(result);
  assert.match(result.stdout, /documentation subset passed/);
  const [record] = await f.records("docs"); assert.notEqual(record.cwd, await realpath(f.root));
  assert.equal(await f.exists(record.cwd), false);
  assert.deepEqual(await readFile(index), before);
  assert.match(await f.read("ignored.test.mjs"), /must not execute/);
});

test("historical selection runner executes full without unknown flags", async t => {
  const f = await pushDocsFixture(t);
  await f.write("scripts/run-tests.mjs", `import assert from 'node:assert/strict';
    assert.equal(process.argv.length,2,'unknown historical flag'); await import('../tests/runtime.test.mjs');`);
  await f.audit(); const base = await f.commit("historical runner");
  await f.write("README.md", "# after historical\n"); const target = await f.commit("historical docs");
  const result = await f.invoke(refLine(target, "docs", base)); passed(result);
  assert.match(result.stdout, /full test suite/);
  assert.equal((await f.records("runtime")).length, 1); assert.equal((await f.records("smoke")).length, 0);
});

test("changed selection, cache, process and package helpers restore the actual full suite", async t => {
  const f = await pushDocsFixture(t);
  assert.equal(await f.supportsSelection(f.root), true, "unmodified independent trusted fixture");
  for (const file of ["scripts/test-selection.mjs", "scripts/gate-cache.mjs", "scripts/push-process-tree.mjs",
    "tests/helpers/packed-template.mjs", "scripts/verify-package.mjs"]) {
    const original = await f.read(file);
    await f.write(file, `${original}\n// historical helper contract\n`);
    await f.audit(); const base = await f.commit("historical helper");
    await f.write("README.md", `# after ${file}\n`); const target = await f.commit("helper target docs");
    const [classified] = await resolvePushTrees(f.root, refs([refLine(target, "docs", base)]), { planForRef: f.planForRef });
    assert.equal(classified.requiredScope, "docs", file);
    assert.equal(await f.supportsSelection(f.root), false, file);
    if (file === "scripts/test-selection.mjs") {
      const before = (await f.records("runtime")).length;
      const result = await f.invoke(refLine(target, "docs", base)); passed(result);
      assert.equal((await f.records("runtime")).length, before + 1, file);
      assert.equal((await f.records("smoke")).length, 0, file);
      assert.match(result.stdout, /running actual target's full test suite/);
    }
    await f.write(file, original);
  }
  await f.remove("scripts/verify-package.mjs");
  await f.audit(); const base = await f.commit("missing historical verifier");
  await f.write("README.md", "# after missing verifier\n"); const target = await f.commit("missing verifier docs");
  const [classified] = await resolvePushTrees(f.root, refs([refLine(target, "docs", base)]), { planForRef: f.planForRef });
  assert.equal(classified.requiredScope, "docs", "missing verifier");
  assert.equal(await f.supportsSelection(f.root), false, "missing verifier");
});

// This runs the actual hook/runner/npm pipeline. Native Windows remains a CI
// qualification; the separate command-boundary control simulates its spawn.
test("docs push preserves an external TEMP with spaces and shell metacharacters and npm lifecycle", async t => {
  const f = await pushDocsFixture(t);
  const temporary = path.join(f.base, "temp space & (owned) %literal% !data! ^");
  await mkdir(temporary);
  Object.assign(f.env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
  const lifecycle = path.join(f.base, "lifecycle");
  const manifest = JSON.parse(await f.read("package.json"));
  Object.assign(manifest.scripts, { pretest: "node lifecycle.mjs", posttest: "node lifecycle.mjs" });
  await f.write("package.json", JSON.stringify(manifest));
  await f.write("lifecycle.mjs", `import {appendFileSync} from 'node:fs';
    appendFileSync(${JSON.stringify(lifecycle)},process.env.npm_lifecycle_event+'\\n');`);
  await f.audit(); const base = await f.commit("npm lifecycle controls");
  await f.write("README.md", "# after special temporary path\n");
  const target = await f.commit("docs under special TEMP");
  const result = await f.invoke(refLine(target, "docs", base)); passed(result);
  assert.match(result.stdout, /documentation subset passed: 8 of 9 files/);
  assert.ok(result.stdout.includes(temporary), "selection plan was not placed in the owned TEMP");
  assert.equal((await f.records("docs")).length, 1);
  assert.equal((await f.records("runtime")).length, 0);
  assert.equal((await f.records("smoke")).length, 1);
  assert.equal((await f.records("packs")).length, 1);
  assert.equal(await readFile(lifecycle, "utf8"), "pretest\nposttest\n");
});
