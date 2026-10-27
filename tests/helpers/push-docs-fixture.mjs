// Real Git/npm execution with the unmodified runner and a tiny synthetic package.
// Copy imports independently of the hook's compatibility list to expose omissions.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGatePlan, sourceDigest } from "../../scripts/change-plan.mjs";
import { readTree } from "../../scripts/change-plan-git.mjs";
import { fixture, invokePush, repo } from "./push-fixture.mjs";

export async function pushDocsFixture(t) {
  const f = await fixture(t);
  const write = async (file, bytes) => {
    await mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
    await writeFile(path.join(f.root, file), bytes);
  };
  const copied = new Set();
  const copy = async file => {
    if (copied.has(file)) return;
    copied.add(file);
    // Isolate npm resolution from unrelated ACC workspace imports. The real
    // template still packs and installs using this real npm CLI on both sides.
    const bytes = file === "tests/helpers/npm-run.mjs" ? `
      import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
      import {npmCli} from '../../packages/cli/src/managed-runtime/npm-cli.mjs';
      export async function runNpm(args,options={}) {
        const npm = await npmCli(options.env ?? process.env);
        return promisify(execFile)(process.execPath,[npm,...args],options);
      }` : await readFile(path.join(repo, file), "utf8");
    await write(file, bytes);
    for (const match of bytes.matchAll(/(?:from\s*|import\s*\()(["'])(\.[^"'${}]+\.mjs)\1/g)) {
      await copy(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2])));
    }
  };
  for (const file of ["scripts/validate-push.mjs", "scripts/check-commit-attribution.mjs", "scripts/check-syntax.mjs",
    "scripts/run-tests.mjs", "scripts/test-skip-fsync.mjs",
    "scripts/test-file-watchdog.mjs", "scripts/test-timing-reporter.mjs"]) await copy(file);
  const controls = Object.fromEntries(["docs", "runtime", "smoke", "packs"]
    .map(name => [name, path.join(f.base, name)]));
  const record = name => `appendFileSync(${JSON.stringify(controls[name])}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');`;
  const manifest = { name: "push-docs-fixture", version: "1.0.0", type: "module", files: ["README.md"],
    scripts: { test: "node scripts/run-tests.mjs" } };
  // npm invokes scripts through cmd.exe on Windows; double quotes preserve the
  // same literal counter command on both shells.
  manifest.scripts.prepack = `node -e "require('node:fs').appendFileSync(${JSON.stringify(controls.packs).replaceAll('"', "'")}, 'pack\\n')"`;
  await write("package.json", JSON.stringify(manifest));
  await write("package-lock.json", JSON.stringify({ name: manifest.name, version: manifest.version,
    lockfileVersion: 3, packages: { "": { name: manifest.name, version: manifest.version } } }));
  await f.remove("target.test.mjs");
  await write(".gitignore", "node_modules/\nignored.test.mjs\n");
  await write("packages/.gitkeep", "");
  await write("README.md", "# before\n");
  await write("tests/docs/probe.test.mjs", `import {appendFileSync,readFileSync} from 'node:fs';
    import assert from 'node:assert/strict'; ${record("docs")}
    assert.match(readFileSync('README.md','utf8'), /^# after/); console.log('DOCS_TARGET_SENTINEL');`);
  await write("tests/runtime.test.mjs", `import {appendFileSync} from 'node:fs'; ${record("runtime")} console.log('FULL_TARGET_SENTINEL');`);
  const readers = JSON.parse(await readFile(path.join(repo, "scripts/validation-impact.json"), "utf8")).externalReaders;
  for (const file of readers) await write(file, "export {};\n");
  await write("scripts/verify-package.mjs", `import {appendFileSync,readFileSync} from 'node:fs';
    import assert from 'node:assert/strict'; import path from 'node:path';
    assert.equal(process.argv.length,3); assert.equal(path.basename(process.argv[2]),'push-docs-fixture-1.0.0.tgz');
    assert.equal(readFileSync(process.argv[2])[0],31); ${record("smoke")} console.log('EXACT_PACKAGE_SENTINEL');`);
  // Both sides of the production byte guard receive this same synthetic
  // verifier. No production comparison or invocation is bypassed. Its npm
  // artifact is a tiny fixture package, never the ACC product artifact.
  const trusted = path.join(f.base, "trusted");
  for (const file of [...copied, "scripts/verify-package.mjs"]) {
    await mkdir(path.dirname(path.join(trusted, file)), { recursive: true });
    await writeFile(path.join(trusted, file), await readFile(path.join(f.root, file)));
  }
  const audit = async () => {
    await f.git(["add", "-A"]);
    const tree = (await f.git(["write-tree"])).stdout.trim();
    await write("scripts/validation-impact.json", JSON.stringify({ schema: 1,
      documentation: ["AGENTS.md", "CHANGELOG.md", "README.md", "SECURITY.md"], documentationRoots: ["docs", "examples"],
      externalReaders: readers, sourceDigest: sourceDigest(await readTree(f.root, tree)) }));
  };
  await audit();
  const baseCommit = await f.commit("audited fixture source");
  await write("README.md", "# after\n");
  const targetCommit = await f.commit("documentation change");
  const planForRef = facts => createGatePlan({ repo: f.root, targetCommit: facts.commit,
    baseCommit: facts.base, event: { kind: "push", ref: facts.ref.remoteRef } });
  const records = async name => (await readFile(controls[name], "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(line => name === "packs" ? line : JSON.parse(line));
  return { ...f, write, audit, baseCommit, targetCommit, planForRef, records,
    invoke: input => invokePush(f, input, path.join(trusted, "scripts/validate-push.mjs")) };
}
