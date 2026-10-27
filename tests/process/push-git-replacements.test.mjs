// Real object aliases must not change pushed bytes, history, or npm's Git reads.
// Removing any trusted Git boundary, child flag, or conditional flag check breaks
// a distinct control below; no fixture delegates to ACC's complete test suite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fixture, invokePush, refLine, repo } from "../helpers/push-fixture.mjs";
import { runNpm } from "../helpers/npm-run.mjs";

const run = promisify(execFile);
async function replacementFixture(t, namespace = "refs/replace/") {
  const f = await fixture(t);
  delete f.env.GIT_NO_REPLACE_OBJECTS;
  delete f.env.GIT_REPLACE_REF_BASE;
  if (namespace !== "refs/replace/") f.env.GIT_REPLACE_REF_BASE = namespace;
  f.replace = (original, replacement) => f.git(["update-ref", `${namespace}${original}`, replacement]);
  return f;
}
async function evaluate(f, source) {
  return (await run(process.execPath, ["--input-type=module", "-e", source], { cwd: f.root, env: f.env })).stdout;
}
const moduleUrl = name => pathToFileURL(path.join(repo, "scripts", name)).href;

for (const defect of ["syntax", "assertion"]) {
  for (const topology of ["current", "isolated"]) {
    test(`replacement cannot certify ${defect} defect through ${topology} checkout`, async t => {
      const f = await replacementFixture(t, topology === "isolated" ? "refs/private-replacements/" : undefined);
      const base = await f.oid();
      await writeFile(path.join(f.root, "module.mjs"), defect === "syntax" ? "export const value = ;\n" : "export const value = false;\n");
      await writeFile(path.join(f.root, "target.test.mjs"), "import assert from 'node:assert/strict'; import {value} from './module.mjs'; assert.equal(value,true,'real pushed assertion');\n");
      const bad = await f.commit("broken original");
      const actualTree = (await f.git(["--no-replace-objects", "rev-parse", `${bad}^{tree}`])).stdout.trim();
      await f.git(["checkout", "-q", base]);
      await writeFile(path.join(f.root, "module.mjs"), "export const value = true;\n");
      await writeFile(path.join(f.root, "target.test.mjs"), "import assert from 'node:assert/strict'; import {value} from './module.mjs'; assert.equal(value,true);\n");
      const good = await f.commit("passing replacement");
      if (topology === "isolated") {
        await writeFile(path.join(f.root, "cwd-only.txt"), "different current tree\n");
        await f.commit("force isolation");
      }
      await f.replace(bad, good);
      assert.notEqual((await f.git(["rev-parse", `${bad}^{tree}`])).stdout.trim(), actualTree,
        "fixture replacement was inactive");
      const result = await invokePush(f, refLine(bad));
      assert.notEqual(result.code, 0, "local replacement certified broken original content");
      assert.match(result.stdout + result.stderr, defect === "syntax" ? /SyntaxError/ : /real pushed assertion/);
      assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 1);
    });
  }
}

test("trusted object facts, byte oracle and materialization ignore active replacement refs", async t => {
  const f = await replacementFixture(t, "refs/private-replacements/");
  const base = await f.oid();
  await writeFile(path.join(f.root, "module.mjs"), "export const original = true;\n");
  const original = await f.commit("original bytes");
  const tree = (await f.git(["--no-replace-objects", "rev-parse", `${original}^{tree}`])).stdout.trim();
  await f.git(["checkout", "-q", base]);
  await writeFile(path.join(f.root, "module.mjs"), "export const substitute = true;\n");
  const substitute = await f.commit("substitute bytes");
  await f.replace(original, substitute);
  const observed = JSON.parse(await evaluate(f, `import {pushGit} from ${JSON.stringify(moduleUrl("push-targets.mjs"))};
    import {checkoutMatchesCommit} from ${JSON.stringify(moduleUrl("push-tree-check.mjs"))};
    const commit=${JSON.stringify(original)}, repo=process.cwd();
    const tree=(await pushGit(repo,['rev-parse',commit+'^{tree}'])).trim();
    console.log(JSON.stringify({tree,matches:await checkoutMatchesCommit(repo,commit)}));`));
  assert.deepEqual(observed, { tree, matches: false });
  const bytes = JSON.parse(await evaluate(f, `import {readFile} from 'node:fs/promises';
    import {withPushCheckout} from ${JSON.stringify(moduleUrl("push-targets.mjs"))};
    await withPushCheckout(process.cwd(),{commit:${JSON.stringify(original)},checkout:'isolated'},async checkout=>{
      console.log(JSON.stringify(await readFile(checkout+'/module.mjs','utf8')));
    });`));
  assert.equal(bytes, "export const original = true;\n");
});

test("replaced old ancestor cannot hide original forbidden attribution in either history caller", async t => {
  const f = await replacementFixture(t, "refs/private-replacements/");
  const base = await f.oid();
  const bad = await f.commit("old ancestor\n\nCo-Authored-By: Claude <noreply@anthropic.com>", true);
  const tip = await f.commit("clean descendant", true);
  const tree = (await f.git(["--no-replace-objects", "rev-parse", `${bad}^{tree}`])).stdout.trim();
  const clean = (await f.git(["commit-tree", tree, "-p", base, "-m", "clean replacement message"])).stdout.trim();
  await f.replace(bad, clean);
  assert.doesNotMatch((await f.git(["log", "--format=%B", tip])).stdout, /Co-Authored-By/);
  await assert.rejects(run(process.execPath, [path.join(repo, "scripts/check-commit-attribution.mjs"), "--history", tip],
    { cwd: f.root, env: f.env }), error => error.code === 1 && /Co-Authored-By/.test(error.stderr));
  const result = await invokePush(f, refLine(tip));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Co-Authored-By/);
  assert.doesNotMatch(result.stdout, /syntax-checking/);
});

for (const namespace of ["refs/replace/", "refs/private-replacements/"]) {
  test(`npm child Git reads original blobs with active ${namespace}`, async t => {
    const f = await replacementFixture(t, namespace);
    await writeFile(path.join(f.root, "history.txt"), "original failure\n");
    await writeFile(path.join(f.root, "target.test.mjs"), `import assert from 'node:assert/strict';
      import {execFileSync} from 'node:child_process';
      assert.equal(execFileSync('git',['show','HEAD:history.txt'],{encoding:'utf8'}),'passing alias\\n','runtime Git object differs');\n`);
    const tip = await f.commit("test reads a real Git blob");
    const original = (await f.git(["rev-parse", "HEAD:history.txt"])).stdout.trim();
    await writeFile(path.join(f.base, "replacement.txt"), "passing alias\n");
    const replacement = (await f.git(["hash-object", "-w", path.join(f.base, "replacement.txt")])).stdout.trim();
    await f.replace(original, replacement);
    await runNpm(["test"], { cwd: f.root, env: f.env }); // The alias really masks the runtime failure.
    const result = await invokePush(f, refLine(tip));
    assert.notEqual(result.code, 0, "npm's own Git child still consumed a substituted blob");
    assert.match(result.stdout + result.stderr, /runtime Git object differs/);
  });
}

for (const value of [undefined, "0"]) {
  test(`ordinary npm environment preserves GIT_NO_REPLACE_OBJECTS=${value}`, async t => {
    const f = await replacementFixture(t);
    if (value !== undefined) f.env.GIT_NO_REPLACE_OBJECTS = value;
    await writeFile(path.join(f.root, "target.test.mjs"), `import assert from 'node:assert/strict';
      assert.equal(process.env.GIT_NO_REPLACE_OBJECTS,${JSON.stringify(value)}); console.log('ordinary npm environment preserved');\n`);
    const tip = await f.commit("ordinary environment control");
    const result = await invokePush(f, refLine(tip));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ordinary npm environment preserved/);
  });
}
