import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { resolveExecutable, runExecutable } from "@agents-can-communicate/adapter-sdk";

import { removeFixture } from "./helpers/fixture-cleanup.mjs";
import { preparePackedArchive } from "./helpers/packed-template.mjs";
import { createPackedAcc } from "./helpers/packed-acc.mjs";

test("archive consumers reuse the run artifact without copying an installed tree", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-archive-copy-")));
  t.after(() => removeFixture(root));
  const template = path.join(root, "template");
  await mkdir(path.join(template, "pack"), { recursive: true });
  const original = path.join(template, "pack", "artifact.tgz");
  await writeFile(original, "from this run");
  const inherited = process.env.ACC_TEST_PACKED_TEMPLATE;
  process.env.ACC_TEST_PACKED_TEMPLATE = template;
  t.after(() => {
    if (inherited === undefined) delete process.env.ACC_TEST_PACKED_TEMPLATE;
    else process.env.ACC_TEST_PACKED_TEMPLATE = inherited;
  });
  const tarball = await preparePackedArchive(path.join(root, "consumer"));
  assert.equal(await readFile(tarball, "utf8"), "from this run");
  assert.notEqual(tarball, original);
  await writeFile(tarball, "changed consumer");
  assert.equal(await readFile(original, "utf8"), "from this run");
});

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
    const executable = await resolveExecutable("acc", {
      pathEnv: path.join(fixture.consumer, "node_modules", ".bin") });
    assert.notEqual(executable, null, "npm must generate the platform executable");
    const { stdout } = await runExecutable(executable, ["version", "--json"],
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
// skipping its finally block must fail these real two-file runs. Only the slow
// pack/install boundary is replaced; runner discovery, child environments, copy
// isolation and cleanup remain real. The test above exercises the real package.
test("the runner shares one fresh template and removes it even when a test fails", async t => {
  const run = promisify(execFile);
  const repo = path.resolve(import.meta.dirname, "..");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-template-runner-")));
  t.after(() => removeFixture(root));
  for (const directory of ["scripts", "tests", "packages", "records"]) await mkdir(path.join(root, directory));
  const moduleUrl = relative => pathToFileURL(path.join(repo, relative)).href;
  const templateModule = path.join(root, "scripts", "template.mjs");
  await writeFile(templateModule, `
    import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import path from "node:path";
    export async function createPackedTemplate() {
      const root = await mkdtemp(path.join(tmpdir(), "acc-runner-template-probe-"));
      await mkdir(path.join(root, "pack"));
      await mkdir(path.join(root, "consumer"));
      await writeFile(path.join(root, "pack", "probe.tgz"), "run artifact");
      await writeFile(path.join(root, "consumer", "marker"), root);
      return root;
    }
  `);
  const source = (await readFile(path.join(repo, "scripts/run-tests.mjs"), "utf8"))
    .replace(/from (["'])(\.[^"']+)\1/g, (_match, _quote, relative) => {
      const target = relative === "../tests/helpers/packed-template.mjs" ? templateModule
        : path.resolve(repo, "scripts", relative);
      return `from ${JSON.stringify(pathToFileURL(target).href)}`;
    });
  const runner = path.join(root, "scripts", "run-tests.mjs");
  await writeFile(runner, source);
  for (const name of ["first", "second"]) {
    await writeFile(path.join(root, "tests", `${name}.test.mjs`), `
      import assert from "node:assert/strict";
      import { mkdtemp, readFile, writeFile } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import path from "node:path";
      import test from "node:test";
      import { preparePackedConsumer } from ${JSON.stringify(moduleUrl("tests/helpers/packed-template.mjs"))};
      import { removeFixture } from ${JSON.stringify(moduleUrl("tests/helpers/fixture-cleanup.mjs"))};
      test("private artifact consumer", async t => {
        const template = process.env.ACC_TEST_PACKED_TEMPLATE;
        assert.ok(template && template !== "inherited-stale-template", "runner must supply its own template");
        const root = await mkdtemp(path.join(tmpdir(), "acc-runner-consumer-probe-"));
        t.after(() => removeFixture(root));
        await preparePackedConsumer(root);
        const installed = path.join(root, "consumer");
        assert.equal(await readFile(path.join(installed, "marker"), "utf8"), template);
        await writeFile(${JSON.stringify(path.join(root, "records", `${name}.json`))},
          JSON.stringify({ template, installed }));
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
    await assert.rejects(lstat(first.template), { code: "ENOENT" }, "the completed run must remove its template");
    previous = first.template;
  }
});
