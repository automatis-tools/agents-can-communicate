import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { removeFixture } from "./helpers/fixture-cleanup.mjs";
import { runNpm } from "./helpers/npm-run.mjs";
import { createPackedAcc } from "./helpers/packed-acc.mjs";

// Ignoring the run's template loses this installed-only marker. Reusing its
// paths or hardlinks lets a consumer's mutation corrupt its peers. Following
// npm's executable symlinks back to the template breaks a relocated consumer.
test("packed consumers reuse the run's artifact without sharing mutable files", async t => {
  const template = await createPackedAcc(t, { fresh: true });
  const marker = "private-copy-proof.txt";
  await writeFile(path.join(template.installed, marker), "from this run\n");
  if (process.platform !== "win32") await chmod(template.accBin, 0o751);
  const inherited = process.env.ACC_TEST_PACKED_TEMPLATE;
  process.env.ACC_TEST_PACKED_TEMPLATE = template.root;
  t.after(() => {
    if (inherited === undefined) delete process.env.ACC_TEST_PACKED_TEMPLATE;
    else process.env.ACC_TEST_PACKED_TEMPLATE = inherited;
  });

  const [first, second] = await Promise.all([createPackedAcc(t), createPackedAcc(t)]);
  for (const fixture of [first, second]) {
    assert.equal(await readFile(path.join(fixture.installed, marker), "utf8").catch(() => null), "from this run\n",
      "the consumer must use this run's installed template");
    assert.notEqual(fixture.installed, template.installed);
    assert.notEqual(fixture.dataHome, template.dataHome);
    if (process.platform !== "win32") {
      assert.equal((await lstat(fixture.accBin)).mode & 0o777, 0o751);
      const link = await readlink(path.join(fixture.consumer, "node_modules", ".bin", "acc"));
      assert.equal(path.isAbsolute(link), false, "the executable link must stay relative");
    }
    const { stdout } = await runNpm(["exec", "--offline", "--", "acc", "version", "--json"],
      { cwd: fixture.consumer, env: { ...fixture.env,
        PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter) } });
    assert.equal(JSON.parse(stdout).data.version, template.manifest.version);
  }
  assert.notEqual(first.dataHome, second.dataHome);
  assert.notEqual(first.clientHome, second.clientHome);

  await writeFile(path.join(first.installed, marker), "changed consumer\n");
  await writeFile(first.tarball, "changed archive\n");
  for (const fixture of [template, second, await createPackedAcc(t)]) {
    assert.equal(await readFile(path.join(fixture.installed, marker), "utf8"), "from this run\n");
    assert.notEqual((await readFile(fixture.tarball)).toString(), "changed archive\n");
  }

  // Installation-specific checks can opt out even inside the shared suite.
  const fresh = await createPackedAcc(t, { fresh: true });
  await assert.rejects(readFile(path.join(fresh.installed, marker)), { code: "ENOENT" },
    "fresh installation must ignore the shared template");
});

// Removing the runner's shared environment, caching across invocations, or
// skipping its finally block must fail these real two-file runs. Discovery is
// constrained by a private checkout containing only the probes; the runner's
// source is unchanged apart from relocating its relative module imports.
test("the runner shares one fresh template and removes it even when a test fails", async t => {
  const run = promisify(execFile);
  const repo = path.resolve(import.meta.dirname, "..");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-template-runner-")));
  t.after(() => removeFixture(root));
  for (const directory of ["scripts", "tests", "packages", "records"]) await mkdir(path.join(root, directory));
  const moduleUrl = relative => pathToFileURL(path.join(repo, relative)).href;
  const source = (await readFile(path.join(repo, "scripts/run-tests.mjs"), "utf8"))
    .replaceAll('from "./test-runner-plan.mjs"', `from ${JSON.stringify(moduleUrl("scripts/test-runner-plan.mjs"))}`)
    .replaceAll('from "../tests/helpers/packed-template.mjs"', `from ${JSON.stringify(moduleUrl("tests/helpers/packed-template.mjs"))}`)
    .replaceAll('from "../tests/helpers/fixture-cleanup.mjs"', `from ${JSON.stringify(moduleUrl("tests/helpers/fixture-cleanup.mjs"))}`);
  const runner = path.join(root, "scripts", "run-tests.mjs");
  await writeFile(runner, source);
  for (const name of ["first", "second"]) {
    await writeFile(path.join(root, "tests", `${name}.test.mjs`), `
      import assert from "node:assert/strict";
      import { writeFile } from "node:fs/promises";
      import test from "node:test";
      import { createPackedAcc } from ${JSON.stringify(moduleUrl("tests/helpers/packed-acc.mjs"))};
      test("private installed consumer", async t => {
        const template = process.env.ACC_TEST_PACKED_TEMPLATE;
        assert.ok(template && template !== "inherited-stale-template", "runner must supply its own template");
        const fixture = await createPackedAcc(t);
        const version = (await fixture.acc(["version"])).version;
        await writeFile(${JSON.stringify(path.join(root, "records", `${name}.json`))},
          JSON.stringify({ template, installed: fixture.installed, version }));
        if (${JSON.stringify(name)} === "first" && process.env.PROBE_FAILURE === "1") {
          assert.fail("deliberate probe failure");
        }
      });
    `);
  }
  let previous = null;
  for (const fail of [false, true]) {
    const env = { ...process.env, ACC_TEST_PACKED_TEMPLATE: "inherited-stale-template",
      PROBE_FAILURE: fail ? "1" : "0" };
    // This is an independent runner, not another child in our node:test file.
    delete env.NODE_TEST_CONTEXT;
    const result = await run(process.execPath, [runner], { cwd: root, env })
      .then(value => ({ ...value, code: 0 }), error => error);
    assert.equal(result.code, fail ? 1 : 0, result.stdout + result.stderr);
    if (fail) assert.match(result.stdout + result.stderr, /deliberate probe failure/);
    const [first, second] = await Promise.all(["first", "second"].map(name =>
      readFile(path.join(root, "records", `${name}.json`), "utf8").then(JSON.parse)));
    // A cleanup mutation must fail the assertion below without leaking evidence
    // directories from the test that demonstrates it.
    t.after(() => removeFixture(first.template));
    assert.equal(first.template, second.template, "test files must reuse one run-scoped template");
    assert.notEqual(first.template, previous, "another invocation must rebuild from current source");
    assert.notEqual(first.installed, second.installed);
    assert.equal(first.version, second.version);
    await assert.rejects(lstat(first.template), { code: "ENOENT" }, "the completed run must remove its template");
    previous = first.template;
  }
});
