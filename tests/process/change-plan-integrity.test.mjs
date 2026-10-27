import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { audit, commit, event, fixture, git, put } from "../helpers/change-plan-fixture.mjs";
import { createGatePlan } from "../../scripts/change-plan.mjs";
import { observePushPlans } from "../../scripts/change-plan-observation.mjs";

for (const [from, into] of [["packages/example/README.md", "docs/copied.md"],
  ["docs/source.md", "packages/example/COPY.md"]]) {
  test(`unchanged Git copy ${from} to ${into} retains its boundary`, async t => {
    const { repo } = await fixture(t);
    await put(repo, from, Array.from({ length: 20 }, (_, index) => `copy source line ${index}: unchanged document content`).join("\n"));
    await audit(repo);
    const base = await commit(repo);
    await put(repo, into, await readFile(path.join(repo, from), "utf8") + "\ncopy footnote\n");
    const target = await commit(repo);
    await git(repo, "config", "diff.renameLimit", "1");
    const plan = await createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
    assert.equal(plan.scope, "full", "copy must retain the non-doc source or destination");
    assert.ok(plan.reasons.includes("changes-require-full"), "copy boundary must be classified, not merely audit drift");
  });
}

for (const kind of ["commit", "tree", "blob"]) {
  test(`Git replacement ${kind} cannot alter exact target identities or content`, async t => {
    const { repo, base, target } = await fixture(t);
    const expected = await createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
    assert.equal(expected.scope, "docs");
    await put(repo, "tests/docs/substituted.test.mjs");
    await audit(repo);
    const alternate = await commit(repo);
    const alternateTree = await git(repo, "rev-parse", `${alternate}^{tree}`);
    // Sibling rather than descendant avoids a replacement-induced parent cycle.
    const sibling = await git(repo, "commit-tree", alternateTree, "-p", base, "-m", "replacement");
    const expression = kind === "commit" ? "" : kind === "tree" ? "^{tree}" : ":scripts/validation-impact.json";
    const original = await git(repo, "rev-parse", `${target}${expression}`);
    const replacement = await git(repo, "rev-parse", `${sibling}${expression}`);
    await git(repo, "replace", original, replacement);
    // Prove the fixture actually substituted content for ordinary Git.
    assert.equal(await git(repo, "cat-file", "-p", original), await git(repo, "cat-file", "-p", replacement));
    const actual = await createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
    assert.deepEqual(actual, expected, "replacement content must not affect any target fact or digest");
  });
}

for (const directory of ["packages/dependency.test.mjs", "packages/dependency"]) {
  test(`gitlink ${directory} cannot fabricate a complete test discovery`, async t => {
    const { repo, target } = await fixture(t);
    await git(repo, "update-index", "--add", "--cacheinfo", `160000,${target},${directory}`);
    await git(repo, "-c", "core.hooksPath=", "commit", "-qm", "gitlink");
    const next = await git(repo, "rev-parse", "HEAD");
    // An initialized directory can contain tests absent from the parent Git tree.
    await mkdir(path.join(repo, directory, "test"), { recursive: true });
    await writeFile(path.join(repo, directory, "test/nested.test.mjs"), "export {};\n");
    await assert.rejects(createGatePlan({ repo, baseCommit: target, targetCommit: next, event }), /discovery-unavailable/);
    const report = await observePushPlans(repo, [{ commit: next, tree: await git(repo, "rev-parse", `${next}^{tree}`),
      requiredScope: "full", refs: [{ localOid: next, remoteOid: target, remoteRef: "refs/heads/topic" }] }]);
    assert.equal(report.targets[0].scope, "full");
    assert.equal(report.targets[0].refs[0].reason, "plan-unavailable");
    assert.equal(report.targets[0].refs[0].plan, undefined);
  });
}

test("ambiguous identical copy sources cannot hide a package boundary", async t => {
  const { repo } = await fixture(t);
  for (const file of ["docs/source.md", "packages/example/README.md"]) await put(repo, file, "ambiguous copy source\n");
  await audit(repo);
  const base = await commit(repo);
  await put(repo, "docs/copied.md", "ambiguous copy source\n");
  const target = await commit(repo);
  assert.equal((await createGatePlan({ repo, baseCommit: base, targetCommit: target, event })).scope, "full");
});

test("equal-similarity edited copy sources cannot hide a package boundary", async t => {
  const { repo } = await fixture(t);
  const common = Array.from({ length: 20 }, (_, index) =>
    `shared source line ${index}: repeatable long phrase for rename similarity`).join("\n");
  await put(repo, "docs/source.md", `${common}\nsource variation A\n`);
  await put(repo, "packages/example/README.md", `${common}\nsource variation B\n`);
  await audit(repo);
  const base = await commit(repo);
  await put(repo, "docs/copied.md", `${common}\nsource variation C\n`);
  const target = await commit(repo);
  const oid = (commit, file) => git(repo, "rev-parse", `${commit}:${file}`);
  const identities = await Promise.all([oid(base, "docs/source.md"), oid(base, "packages/example/README.md"),
    oid(target, "docs/copied.md")]);
  assert.equal(new Set(identities).size, 3, "all source and target blobs must be distinct");
  const diff = (...paths) => git(repo, "diff", "--raw", "-z", "--find-renames", "--find-copies-harder",
    "-l0", base, target, "--", ...paths);
  const docs = await diff("docs/source.md", "docs/copied.md");
  const packageSource = await diff("packages/example/README.md", "docs/copied.md");
  const selected = await diff();
  const score = raw => raw.match(/ C(\d{3})\0/)?.[1];
  assert.ok(score(docs), "Git must detect the edited documentation source");
  assert.equal(score(packageSource), score(docs), "both sources must have equal Git similarity");
  assert.match(selected, / C\d{3}\0docs\/source\.md\0docs\/copied\.md\0/,
    "full Git diff must select the documentation source");
  const plan = await createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
  assert.equal(plan.scope, "full", "a selected edited copy needs full validation despite its documentation path");
  assert.ok(plan.reasons.includes("copy-origin-ambiguous"));
});

test("Git C100 after line reordering is not byte-identical documentation", async t => {
  const { repo } = await fixture(t);
  const lines = Array.from({ length: 25 }, (_, index) =>
    `reorderable long documentation line ${String(index).padStart(2, "0")}: common content repeated enough for Git`);
  await put(repo, "docs/source.md", `${lines.join("\n")}\n`);
  await audit(repo);
  const base = await commit(repo);
  await put(repo, "docs/copied.md", `${[...lines].reverse().join("\n")}\n`);
  const target = await commit(repo);
  const raw = await git(repo, "diff", "--raw", "-z", "--find-copies-harder", "-l0", base, target, "--");
  assert.match(raw, / C100\0docs\/source\.md\0docs\/copied\.md\0/);
  assert.notEqual(await git(repo, "rev-parse", `${base}:docs/source.md`),
    await git(repo, "rev-parse", `${target}:docs/copied.md`));
  const plan = await createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
  assert.equal(plan.scope, "full");
  assert.ok(plan.reasons.includes("copy-origin-ambiguous"));
});


for (const operation of ["copy", "rename"]) {
  for (const ambiguous of [true, false]) {
    test(`edited ${operation} with ${ambiguous ? "ambiguous" : "unambiguous"} source requires full validation`, async t => {
      const { repo } = await fixture(t);
      const content = Array.from({ length: 20 }, (_, index) => `copy source line ${index}: unchanged document content`).join("\n");
      await put(repo, "docs/source.md", content);
      if (ambiguous) await put(repo, "packages/example/README.md", content);
      await audit(repo);
      const base = await commit(repo);
      await put(repo, "docs/copied.md", content + "\ncopy footnote\n");
      if (operation === "rename") await rm(path.join(repo, "docs/source.md"));
      const target = await commit(repo);
      const raw = await git(repo, "diff", "--raw", "-z", "--find-renames", "--find-copies-harder", "-l0", base, target, "--");
      assert.match(raw, /[CR]093\0docs\/source\.md\0docs\/copied\.md\0/,
        "fixture must exercise Git's edited documentation-source choice");
      const plan = await createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
      assert.equal(plan.scope, "full");
      assert.ok(plan.reasons.includes("copy-origin-ambiguous"));
    });
  }
}

for (const operation of ["copy", "rename"]) {
  test(`byte-identical documentation ${operation} remains docs-only`, async t => {
    const { repo } = await fixture(t);
    const content = Array.from({ length: 20 }, (_, index) => `identical documentation line ${index}`).join("\n");
    await put(repo, "docs/source.md", content);
    await audit(repo);
    const base = await commit(repo);
    await put(repo, "docs/copied.md", content);
    if (operation === "rename") await rm(path.join(repo, "docs/source.md"));
    const target = await commit(repo);
    const raw = await git(repo, "diff", "--raw", "-z", "--find-renames", "--find-copies-harder",
      "-l0", base, target, "--");
    assert.match(raw, new RegExp(` ${operation === "copy" ? "C" : "R"}100\\0docs/source\\.md\\0docs/copied\\.md\\0`));
    const plan = await createGatePlan({ repo, baseCommit: base, targetCommit: target, event });
    assert.equal(plan.scope, "docs");
    assert.ok(!plan.reasons.includes("copy-origin-ambiguous"));
  });
}
