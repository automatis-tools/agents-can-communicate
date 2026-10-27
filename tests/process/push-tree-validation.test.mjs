// These real target tests catch the original cwd substitution: the checked-out
// commit passes while the different pushed tree fails its own syntax or suite.
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkoutMatchesCommit } from "../../scripts/push-tree-check.mjs";
import { fixture, invokePush, refLine } from "../helpers/push-fixture.mjs";

for (const defect of ["syntax", "test"]) {
  test(`a passing cwd cannot certify another pushed tree with a ${defect} defect`, async t => {
    const f = await fixture(t);
    const good = await f.oid();
    await writeFile(path.join(f.root, defect === "syntax" ? "module.mjs" : "target.test.mjs"),
      defect === "syntax" ? "export const = ;\n" : "import assert from 'node:assert/strict'; assert.fail('actual target defect');\n");
    const bad = await f.commit("broken target");
    await f.git(["checkout", "-q", good]);
    const result = await invokePush(f, refLine(bad));
    assert.notEqual(result.code, 0, "the passing cwd incorrectly certified broken pushed content");
    assert.match(result.stderr + result.stdout, defect === "syntax" ? /module\.mjs/ : /actual target defect/);
    assert.equal(await f.oid(), good);
    assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 1);
  });
}

test("both distinct pushed trees run and a failure refuses the complete push", async t => {
  const f = await fixture(t);
  const good = await f.oid();
  await writeFile(path.join(f.root, "target.test.mjs"), "throw Error('second tree fails');\n");
  const bad = await f.commit("second tree");
  await f.git(["checkout", "-q", good]);
  const result = await invokePush(f, `${refLine(good)}\n${refLine(bad, "other")}`);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /actual target passed/);
  assert.match(result.stderr + result.stdout, /second tree fails/);
});

test("measurement syntax is checked in the actual target and normal refs win a shared tree", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "target.test.mjs"), "throw Error('normal must run');\n");
  const bad = await f.commit("failing suite");
  const measurement = await invokePush(f, refLine(bad, "measure/probe"));
  assert.equal(measurement.code, 0, measurement.stderr);
  assert.match(measurement.stdout, /measurement-only.*no suite/);
  const both = await invokePush(f, `${refLine(bad, "measure/probe")}\n${refLine(bad, "normal")}`);
  assert.notEqual(both.code, 0);
  assert.match(both.stderr + both.stdout, /normal must run/);
});

test("dirty and untracked passing files never replace committed failing inputs", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "target.test.mjs"), "throw Error('committed failure');\n");
  const bad = await f.commit("bad committed test");
  await writeFile(path.join(f.root, "target.test.mjs"), "console.log('dirty pass');\n");
  await writeFile(path.join(f.root, "extra.test.mjs"), "console.log('untracked');\n");
  const result = await invokePush(f, refLine(bad));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /committed failure/);
  assert.equal(await f.read("target.test.mjs"), "console.log('dirty pass');\n");
  assert.equal(await f.read("extra.test.mjs"), "console.log('untracked');\n");
});

test("an unsupported target runner receives its actual full suite without receipt options", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "target.test.mjs"),
    "import assert from 'node:assert/strict'; assert.equal(process.argv.length, 2); console.log('legacy full suite passed');\n");
  const oid = await f.commit("legacy contract");
  const result = await invokePush(f, refLine(oid));
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /legacy full suite passed/);
});

test("tree deduplication cannot hide attributed history on another same-tree commit", async t => {
  const f = await fixture(t);
  const good = await f.oid();
  const bad = await f.commit("attributed history\n\nClaude-Session: https://claude.ai/code/session_fixture", true);
  const result = await invokePush(f, `${refLine(good, "measure/clean")}\n${refLine(bad, "normal")}`);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Claude attribution/);
  assert.doesNotMatch(result.stdout, /syntax-checking|actual target passed/);
});


for (const kind of ["file", "directory", "ignored"]) {
  test(`unlisted passing bytes behind a tracked ${kind} symlink cannot certify a pushed tree`,
    { skip: process.platform === "win32" }, async t => {
      const f = await fixture(t);
      let target;
      if (kind === "directory") {
        target = path.join(f.base, "outside");
        await mkdir(target);
        await writeFile(path.join(target, "pass.mjs"), "export {};\n");
      } else if (kind === "ignored") {
        await mkdir(path.join(f.root, ".superpowers"));
        await f.git(["config", "core.excludesFile", path.join(f.base, "ignore")]);
        await writeFile(path.join(f.base, "ignore"), ".superpowers/\n");
        target = ".superpowers/pass.mjs";
        await writeFile(path.join(f.root, target), "export {};\n");
      } else {
        target = path.join(f.base, "outside.mjs");
        await writeFile(target, "export {};\n");
      }
      await symlink(target, path.join(f.root, kind === "directory" ? "linked" : "linked.mjs"));
      await writeFile(path.join(f.root, "target.test.mjs"),
        `import './${kind === "directory" ? "linked/pass.mjs" : "linked.mjs"}'; console.log('unlisted passing input ran');\n`);
      const oid = await f.commit("tracked link to unlisted executable input");
      const result = await invokePush(f, refLine(oid));
      assert.notEqual(result.code, 0, "unlisted passing bytes incorrectly certified the target");
      assert.match(result.stderr, /unsupported pushed checkout topology/);
      assert.doesNotMatch(result.stdout, /unlisted passing input ran/);
      assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 1);
    });
}

// Removing the administrative membership check makes these real imports pass
// only in cwd; their clean materialized target has no such executable input.
for (const directory of [".superpowers", ".agents", ".idea", ".gitworktrees", ".worktrees"]) {
  test(`ignored ${directory} direct import cannot certify a pushed tree`, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.root, ".gitignore"), `${directory}/\n`);
    await mkdir(path.join(f.root, directory));
    await writeFile(path.join(f.root, directory, "pass.mjs"), "export {};\n");
    await writeFile(path.join(f.root, "target.test.mjs"),
      `import './${directory}/pass.mjs'; console.log('unlisted direct input ran');\n`);
    const oid = await f.commit("direct import of ignored input");
    const result = await invokePush(f, refLine(oid));
    assert.notEqual(result.code, 0, "ignored executable input falsely certified the pushed tree");
    assert.match(result.stderr + result.stdout, /ERR_MODULE_NOT_FOUND/);
    assert.doesNotMatch(result.stdout, /unlisted direct input ran/);
    assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 1);
  });
}

test("ignored administrative documentation preserves current checkout eligibility", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, ".gitignore"), ".superpowers/\n.agents/\n.idea/\n");
  const oid = await f.commit("ignore local planning documents");
  for (const directory of [".superpowers", ".agents", ".idea"]) {
    await mkdir(path.join(f.root, directory, "notes"), { recursive: true });
    await writeFile(path.join(f.root, directory, "notes", "review.md"), "# Review notes\n");
    await writeFile(path.join(f.root, directory, "notes", "SKILL.md"), "---\nname: fixture\n---\n# Skill\n");
  }
  assert.equal(await checkoutMatchesCommit(f.root, oid), true);
});


test("actual SDD documentation and validated markers preserve current checkout eligibility", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, ".gitignore"), ".superpowers/\n");
  const oid = await f.commit("ignore local SDD metadata");
  await mkdir(path.join(f.root, ".superpowers/sdd/fixture"), { recursive: true });
  await writeFile(path.join(f.root, ".superpowers/sdd/.gitignore"), "*\n");
  await writeFile(path.join(f.root, ".superpowers/sdd/fixture/plan-path"), "/private/tmp/fixture/plan.md\n");
  await writeFile(path.join(f.root, ".superpowers/sdd/fixture/review.md"), "# Review\n");
  assert.equal(await checkoutMatchesCommit(f.root, oid), true);
  await writeFile(path.join(f.root, ".superpowers/sdd/fixture/plan-path"), "console.log('executable marker')\n");
  assert.equal(await checkoutMatchesCommit(f.root, oid), false, "marker filename exempted executable contents");
});

for (const kind of ["symlink", "executable", "unknown", "metadata-code"]) {
  test(`administrative ${kind} topology remains uncertain`, { skip: process.platform === "win32" && kind !== "unknown" }, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.root, ".gitignore"), ".superpowers/\n");
    const oid = await f.commit("ignore administrative directory");
    await mkdir(path.join(f.root, ".superpowers/sdd"), { recursive: true });
    const file = path.join(f.root, ".superpowers", kind === "unknown" ? "config.json" : kind === "metadata-code" ? "sdd/.gitignore" : "review.md");
    if (kind === "symlink") await symlink("../module.mjs", file);
    else {
      await writeFile(file, kind === "metadata-code" ? "console.log('not metadata')" : "# Notes\n");
      if (kind === "executable") await chmod(file, 0o755);
    }
    assert.equal(await checkoutMatchesCommit(f.root, oid), false);
  });
}

test("a Markdown filename cannot hide an ignored CommonJS executable input", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, ".gitignore"), ".superpowers/\n");
  await mkdir(path.join(f.root, ".superpowers"));
  await writeFile(path.join(f.root, ".superpowers/pass.md"), "module.exports = true;\n");
  await writeFile(path.join(f.root, "target.test.mjs"),
    "import { createRequire } from 'node:module'; createRequire(import.meta.url)('./.superpowers/pass.md'); console.log('disguised code ran');\n");
  const oid = await f.commit("require ignored executable Markdown");
  const result = await invokePush(f, refLine(oid));
  assert.notEqual(result.code, 0, "Markdown suffix exempted executable input");
  assert.match(result.stderr + result.stdout, /MODULE_NOT_FOUND/);
  assert.doesNotMatch(result.stdout, /disguised code ran/);
});

for (const marker of ["a/b.md", "/x/g.test.md", "//fixture.md"]) {
  test(`JavaScript-compatible plan-path ${marker} cannot certify a pushed tree`, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.root, ".gitignore"), ".superpowers/\n");
    await mkdir(path.join(f.root, ".superpowers/sdd/fixture"), { recursive: true });
    await writeFile(path.join(f.root, ".superpowers/sdd/fixture/plan-path"), `${marker}\n`);
    await writeFile(path.join(f.root, "target.test.mjs"),
      "import { createRequire } from 'node:module'; globalThis.a=4; globalThis.b={md:2}; createRequire(import.meta.url)('./.superpowers/sdd/fixture/plan-path'); console.log('ambiguous marker ran');\n");
    const oid = await f.commit("require executable SDD marker");
    const result = await invokePush(f, refLine(oid));
    assert.notEqual(result.code, 0, "path-shaped executable marker exempted missing input");
    assert.match(result.stderr + result.stdout, /MODULE_NOT_FOUND/);
    assert.doesNotMatch(result.stdout, /ambiguous marker ran/);
  });
}
