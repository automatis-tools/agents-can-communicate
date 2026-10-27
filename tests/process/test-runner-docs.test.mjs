import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createGatePlan, digest } from "../../scripts/change-plan.mjs";
import { scopedRunnerFixture } from "../helpers/scoped-runner-fixture.mjs";

const passed = result => assert.equal(result.code, 0, result.stdout + result.stderr);
test("validated docs executes only its selection and exact package smoke; list has no execution effects", async t => {
  const f = await scopedRunnerFixture(t);
  const listed = await f.docs(["--list"]); passed(listed);
  assert.match(listed.stdout, /tests\/docs\/probe.test.mjs/); assert.doesNotMatch(listed.stdout, /runtime.test.mjs/);
  assert.equal(await f.count("packs"), 0); assert.equal(await f.count("smoke"), 0);
  const result = await f.docs(); passed(result); assert.match(result.stdout, /documentation subset passed: 8 of 9 files/);
  assert.equal(await f.count("docs"), 1); assert.equal(await f.count("runtime"), 0);
  assert.equal(await f.count("packs"), 1); assert.equal(await f.count("smoke"), 1);
  passed(await f.docs(["--list"]));
  passed(await f.docs(["--if-needed"])); assert.equal(await f.count("packs"), 1);
});

test("docs proof cannot satisfy full and full cannot satisfy docs", async t => {
  const f = await scopedRunnerFixture(t);
  passed(await f.docs()); passed(await f.invoke(["--if-needed"]));
  assert.equal(await f.count("runtime"), 1, "docs proof certified full execution");
  passed(await f.docs(["--if-needed"])); assert.equal(await f.count("packs"), 3, "full proof certified docs");
});

test("failed docs rerun invalidates both namespaces including equivalent ref plans", async t => {
  const f = await scopedRunnerFixture(t);
  passed(await f.invoke());
  await writeFile(f.controls.failure, "fail"); assert.equal((await f.docs()).code, 1);
  await rm(f.controls.failure); passed(await f.invoke(["--if-needed"]));
  assert.equal(await f.count("runtime"), 2, "failed docs retained a full proof");
  passed(await f.docs());
  const alias = await createGatePlan({ repo: f.root, targetCommit: f.plan.targetCommit,
    baseCommit: f.plan.reasons.find(reason => reason.startsWith("base-commit:")).slice(12),
    event: { kind: "push", ref: "refs/heads/equivalent-docs" } });
  assert.notEqual(alias.planDigest, f.plan.planDigest);
  await writeFile(f.planFile, JSON.stringify(alias));
  await writeFile(f.controls.failure, "fail"); assert.equal((await f.docs()).code, 1);
  await writeFile(f.planFile, JSON.stringify(f.plan));
  await rm(f.controls.failure); passed(await f.docs(["--if-needed"])); assert.equal(await f.count("packs"), 6);
});

test("failed package smoke cannot certify documentation", async t => {
  const f = await scopedRunnerFixture(t);
  await writeFile(f.controls.smokeFailure, "fail"); assert.equal((await f.docs()).code, 1);
  await rm(f.controls.smokeFailure); passed(await f.docs(["--if-needed"]));
  assert.equal(await f.count("smoke"), 2); assert.equal(await f.count("packs"), 2);
});

test("invalid, missing, rehashed edited and stale selections fall back to actual full discovery", async t => {
  const f = await scopedRunnerFixture(t);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const { planDigest, ...edited } = { ...f.plan, selectedFiles: [] };
  const variants = ["{broken", JSON.stringify({ ...f.plan, planDigest: "0".repeat(64) }),
    JSON.stringify({ ...edited, planDigest: digest(canonical(edited)) })];
  for (const bytes of variants) {
    await writeFile(f.planFile, bytes); passed(await f.docs());
  }
  await rm(f.planFile); passed(await f.docs());
  assert.equal(await f.count("runtime"), variants.length + 1);
});

test("dirty bytes, removed selections and new or ignored inputs force full", async t => {
  const f = await scopedRunnerFixture(t);
  for (const [file, bytes] of [["README.md", "# dirty\n"], ["tests/coverage/ignored.test.mjs", "export {};\n"],
    ["tests/new.test.mjs", "export {};\n"]]) {
    await f.write(file, bytes); passed(await f.docs());
    if (file === "README.md") await f.git(["checkout", "--", file]); else await rm(path.join(f.root, file));
  }
  await rm(path.join(f.root, "tests/docs/probe.test.mjs")); passed(await f.docs());
  assert.equal(await f.count("runtime"), 4);
});

test("CI and transient restored edits never certify docs; environment and dependencies prevent reuse", async t => {
  const f = await scopedRunnerFixture(t);
  passed(await f.docs([], { CI: "1" })); passed(await f.docs(["--if-needed"], { CI: "1" }));
  passed(await f.docs()); passed(await f.docs(["--if-needed"], { ACC_SCOPED_CHANGED: "1" }));
  await writeFile(f.controls.change, "yes"); await writeFile(f.controls.restore, "yes"); passed(await f.docs());
  await rm(f.controls.change); await rm(f.controls.restore); passed(await f.docs(["--if-needed"]));
  assert.equal(await f.count("packs"), 6);
  await mkdir(path.join(f.root, "node_modules/unknown"), { recursive: true });
  passed(await f.docs(["--if-needed"])); assert.equal(await f.count("runtime"), 1);
});


test("docs diagnostic records actual scope, validated digests and smoke separately without plan bytes", async t => {
  const f = await scopedRunnerFixture(t); const destination = path.join(f.base, "manifest.json");
  passed(await f.docs([], { ACC_GATE_DIAGNOSTIC: destination }));
  const raw = await readFile(destination, "utf8"); const record = JSON.parse(raw);
  assert.doesNotMatch(raw, /refs\/heads|scoped-runner-|targetCommit|selectedFiles/);
  assert.equal(record.events.find(event => event.event === "package-smoke").result, "passed");
  for (const event of record.events) {
    assert.equal(event.scope, "docs"); assert.equal(event.planDigest, f.plan.planDigest);
    assert.equal(event.selectionDigest, f.plan.selectionDigest);
  }
});

test("an unremovable exact-key proof refuses before packing, while absent cache still executes", async t => {
  const f = await scopedRunnerFixture(t);
  const wrapper = path.join(f.base, "denied-cache.mjs");
  const actual = new URL("../../scripts/gate-cache.mjs", import.meta.url).href;
  await writeFile(wrapper, `export * from ${JSON.stringify(actual)};
    import { invalidateGateProofs as actual } from ${JSON.stringify(actual)};
    export const invalidateGateProofs = snapshot => actual(snapshot, { remove: async () => { throw Error('denied'); } });`);
  const runner = path.join(f.root, "scripts/run-tests.mjs");
  const { pathToFileURL } = await import("node:url");
  await writeFile(runner, (await readFile(runner, "utf8")).replace(/from "[^"]*\/gate-cache\.mjs"/,
    `from ${JSON.stringify(pathToFileURL(wrapper).href)}`));
  passed(await f.invoke()); assert.equal(await f.count("packs"), 1);
  const result = await f.invoke(); assert.equal(result.code, 1);
  assert.match(result.stderr, /existing gate proof could not be invalidated; validation did not start/);
  assert.equal(await f.count("packs"), 1, "validation executed despite a readable proof that could not be removed");
});


test("an explicit valid full plan runs complete discovery without docs smoke", async t => {
  const f = await scopedRunnerFixture(t);
  const full = await createGatePlan({ repo: f.root, targetCommit: f.plan.targetCommit,
    baseCommit: f.plan.reasons.find(reason => reason.startsWith("base-commit:")).slice(12), event: "release" });
  assert.equal(full.scope, "full"); await writeFile(f.planFile, JSON.stringify(full));
  passed(await f.docs()); assert.equal(await f.count("runtime"), 1); assert.equal(await f.count("smoke"), 0);
});
