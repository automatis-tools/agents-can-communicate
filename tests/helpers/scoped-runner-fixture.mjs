import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGatePlan, sourceDigest } from "../../scripts/change-plan.mjs";
import { readTree } from "../../scripts/change-plan-git.mjs";
import { removeFixture } from "./fixture-cleanup.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
export async function scopedRunnerFixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "acc-scoped-runner-"));
  t.after(() => removeFixture(base));
  const root = path.join(base, "work");
  const controls = Object.fromEntries(["docs", "runtime", "packs", "smoke", "failure", "smokeFailure", "change", "restore"]
    .map(name => [name, path.join(base, name)]));
  const env = { ...process.env, ACC_TEST_FORCE_EXIT: "0" };
  for (const name of ["CI", "NODE_TEST_CONTEXT", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GITHUB_STEP_SUMMARY", "ACC_TEST_TIMINGS", "ACC_GATE_DIAGNOSTIC"])
    delete env[name];
  const git = async args => (await run("git", ["-C", root, ...args], { env })).stdout.trim();
  const write = async (name, value) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), value); };
  const source = (await readFile(path.join(repo, "scripts/run-tests.mjs"), "utf8"))
    .replaceAll(/from "(\.\/[^\"]+\.mjs)"/g, (_whole, relative) => `from ${JSON.stringify(pathToFileURL(path.join(repo, "scripts", relative)).href)}`)
    .replace('from "../tests/helpers/packed-template.mjs"', 'from "./fake-template.mjs"')
    .replace('from "../tests/helpers/fixture-cleanup.mjs"', `from ${JSON.stringify(pathToFileURL(path.join(repo, "tests/helpers/fixture-cleanup.mjs")).href)}`);
  await write("scripts/run-tests.mjs", source);
  await write("scripts/fake-template.mjs", `
    import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os'; import path from 'node:path';
    export async function createPackedTemplate() {
      await writeFile(${JSON.stringify(controls.packs)}, String(Number(await readFile(${JSON.stringify(controls.packs)}, 'utf8').catch(() => '0')) + 1));
      const root = await mkdtemp(path.join(tmpdir(), 'acc-scoped-template-'));
      await mkdir(path.join(root, 'pack')); await writeFile(path.join(root, 'pack', 'exact.tgz'), 'synthetic artifact'); return root;
    }
  `);
  const counter = file => `await writeFile(${JSON.stringify(file)}, String(Number(await readFile(${JSON.stringify(file)}, 'utf8').catch(() => '0')) + 1));`;
  await write("tests/docs/probe.test.mjs", `
    import { readFile, writeFile } from 'node:fs/promises'; import assert from 'node:assert/strict';
    ${counter(controls.docs)}
    assert.equal(await readFile(${JSON.stringify(controls.failure)}, 'utf8').catch(() => ''), '');
    if (await readFile(${JSON.stringify(controls.change)}, 'utf8').catch(() => '')) {
      const file = ${JSON.stringify(path.join(root, 'README.md'))}; const bytes = await readFile(file);
      await writeFile(file, '# transient');
      if (await readFile(${JSON.stringify(controls.restore)}, 'utf8').catch(() => '')) await writeFile(file, bytes);
    }
  `);
  await write("tests/runtime.test.mjs", `import { readFile, writeFile } from 'node:fs/promises'; ${counter(controls.runtime)}`);
  await write("scripts/verify-package.mjs", `
    import assert from 'node:assert/strict'; import path from 'node:path'; import { readFile, writeFile } from 'node:fs/promises';
    assert.equal(process.argv.length, 3); assert.equal(path.basename(process.argv[2]), 'exact.tgz');
    assert.equal(await readFile(process.argv[2], 'utf8'), 'synthetic artifact');
    assert.equal(process.env.ACC_NO_UPDATE_CHECK, '1'); assert.equal(process.env.TMPDIR, process.env.TMP); assert.equal(process.env.TMP, process.env.TEMP);
    ${counter(controls.smoke)}
    assert.equal(await readFile(${JSON.stringify(controls.smokeFailure)}, 'utf8').catch(() => ''), '');
  `);
  const readers = ["tests/acceptance/package-links.test.mjs", "tests/acceptance/packaging.test.mjs",
    "tests/acceptance/recorded-candidate.test.mjs", "tests/package-certification.test.mjs", "tests/process/orchestration-is-absent.test.mjs",
    "tests/process/session-resolution.test.mjs", "tests/process/surface-coverage.test.mjs"];
  for (const file of readers) await write(file, "export {};\n");
  await write("packages/.gitkeep", "");
  await write("README.md", "# before\n");
  await write(".gitignore", "coverage/\nnode_modules/\n");
  await run("git", ["init", "-q", root], { env });
  await git(["config", "user.name", "Fixture"]); await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["add", "."]); await git(["commit", "-qm", "source"]);
  await write("scripts/validation-impact.json", JSON.stringify({ schema: 1, documentation: ["AGENTS.md", "CHANGELOG.md", "README.md", "SECURITY.md"],
    documentationRoots: ["docs", "examples"], externalReaders: readers, sourceDigest: sourceDigest(await readTree(root, await git(["rev-parse", "HEAD^{tree}"]))) }));
  await git(["add", "."]); await git(["commit", "-qm", "audit"]);
  const baseCommit = await git(["rev-parse", "HEAD"]);
  await write("README.md", "# after\n"); await git(["add", "."]); await git(["commit", "-qm", "docs"]);
  const plan = await createGatePlan({ repo: root, targetCommit: await git(["rev-parse", "HEAD"]), baseCommit,
    event: { kind: "push", ref: "refs/heads/docs" } });
  assert.equal(plan.scope, "docs", JSON.stringify(plan));
  const planFile = path.join(base, "plan.json"); await writeFile(planFile, JSON.stringify(plan));
  const invoke = (args = [], extraEnv = {}) => run(process.execPath, [path.join(root, "scripts/run-tests.mjs"), ...args], {
    cwd: root, env: { ...env, ...extraEnv }, timeout: 30_000,
  }).then(value => ({ ...value, code: 0 }), error => error);
  return { base, root, controls, plan, planFile, git, write, env, invoke, docs: (args = [], extra = {}) => invoke(["--selection-plan", planFile, ...args], extra),
    count: async name => Number(await readFile(controls[name], "utf8").catch(() => "0")) };
}
