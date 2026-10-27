import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const planner = await import("../scripts/change-plan.mjs").catch(() => ({}));
const discovery = await import("../scripts/validation-discovery.mjs").catch(() => ({}));
const manifest = { schema: 1, documentation: ["README.md", "SECURITY.md", "AGENTS.md", "CHANGELOG.md"],
  documentationRoots: ["docs", "examples"], externalReaders: [], sourceDigest: "a".repeat(64) };
const record = (status, oldPath, newPath, oldMode = "100644", newMode = "100644") =>
  ({ status, oldPath, newPath, oldMode, newMode });
const classify = changes => planner.classifyChanges({ changes, complete: true, ancestryVerified: true, manifest });

test("ordinary Markdown additions, edits, removals and in-boundary moves may propose docs", () => {
  assert.equal(typeof planner.classifyChanges, "function", "classifier is not implemented");
  for (const change of [record("A", null, "docs/new file.md", null),
    record("M", "README.md", "README.md"), record("D", "docs/old.md", null, "100644", null),
    record("R", "docs/old.md", "examples/new\nname.md"), record("C", "README.md", "docs/copy.md")]) {
    assert.equal(classify([change]).scope, "docs");
  }
});

test("runtime, unknown paths, boundary crossings and malformed records cannot propose docs", () => {
  assert.equal(typeof planner.classifyChanges, "function");
  const docs = record("M", "README.md", "README.md");
  for (const file of ["bin/a.mjs", "packages/a/README.md", "skills/a.md", "tests/new.test.mjs",
    "scripts/validation-impact.json", ".github/workflows/test.yml", "examples/run.mjs", "docs/logo.svg",
    "OTHER.md", "docs/../package.json", "docs//a.md", "docs\\a.md", "docs/\ud800.md"]) {
    for (const change of [record("A", null, file, null), record("D", file, null, "100644", null),
      record("M", file, file), record("R", file, "docs/new.md"), record("R", "docs/old.md", file),
      record("C", file, "docs/new.md"), record("C", "docs/old.md", file)]) {
      assert.equal(classify([docs, change]).scope, "full", JSON.stringify(change));
    }
  }
  for (const change of [record("T", "README.md", "README.md", "120000"),
    record("M", "README.md", "README.md", "100644", "100755"),
    record("M", "README.md", "README.md", "120000", "120000"),
    record("Q", "README.md", "README.md"), record("M", null, "README.md"),
    record("A", "README.md", "docs/a.md"), record("M", "README.md", "SECURITY.md")]) {
    assert.equal(classify([change]).scope, "full");
  }
  for (const overrides of [{ changes: [] }, { complete: false }, { ancestryVerified: false }, { manifest: {} }, { manifest: { schema: 1, documentation: {} } }]) {
    assert.equal(planner.classifyChanges({ changes: [docs], complete: true, ancestryVerified: true,
      manifest, ...overrides }).scope, "full");
  }
});

test("shared filesystem discovery preserves the old complete collector including untracked files", async t => {
  assert.equal(typeof discovery.discoverTestFiles, "function", "discovery is not implemented");
  const into = await mkdtemp(path.join(tmpdir(), "acc-discovery-"));
  t.after(() => rm(into, { recursive: true, force: true }));
  for (const file of ["tests/new.test.mjs", "packages/a/test/a.test.mjs", "tests/docs/new.test.mjs",
    "tests/node_modules/no.test.mjs", "packages/.git/no.test.mjs", "tests/helper.mjs"]) {
    await mkdir(path.dirname(path.join(into, file)), { recursive: true });
    await writeFile(path.join(into, file), "");
  }
  assert.deepEqual(await discovery.discoverTestFiles(into), ["packages/a/test/a.test.mjs",
    "tests/docs/new.test.mjs", "tests/new.test.mjs"].map(file => path.join(into, file)));
  // Independent copy of the previous collector is an equivalence oracle, not a new allowlist.
  async function oldCollect(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await oldCollect(full));
      else if (entry.name.endsWith(".test.mjs")) found.push(full);
    }
    return found;
  }
  const expected = (await Promise.all(["tests", "packages"].map(root => oldCollect(path.join(repo, root))))).flat().sort();
  assert.deepEqual(await discovery.discoverTestFiles(repo), expected);
});

test("docs selection keeps direct readers and transitive packed-artifact consumers from actual source", async () => {
  const policy = JSON.parse(await readFile(path.join(repo, "scripts/validation-impact.json"), "utf8"));
  const selected = new Set(policy.externalReaders);
  const direct = [
    ["tests/process/surface-coverage.test.mjs", /readFile\(path\.join\(repo, "docs", "(?:ARCHITECTURE|PROTOCOL|CLI)\.md"/],
    ["tests/process/session-resolution.test.mjs", /readFile\(path\.join\(repo, "README\.md"/],
    ["tests/acceptance/recorded-candidate.test.mjs", /readFile\(path\.join\(repo, "CHANGELOG\.md"/],
  ];
  for (const [file, reader] of direct) {
    assert.match(await readFile(path.join(repo, file), "utf8"), reader, `${file}: re-audit the actual read operation`);
    assert.ok(selected.has(file), `${file}: direct documentation consumer was omitted`);
  }
  const template = await readFile(path.join(repo, "tests/helpers/packed-template.mjs"), "utf8");
  assert.match(template, /runNpm\(\["pack"/);
  for (const file of ["tests/acceptance/package-links.test.mjs", "tests/acceptance/packaging.test.mjs",
    "tests/process/orchestration-is-absent.test.mjs"]) {
    const source = await readFile(path.join(repo, file), "utf8");
    assert.match(source, /import \{ preparePackedArchive \} from "\.\.\/helpers\/packed-template\.mjs"/);
    assert.match(source, /(?:markdown|README\.md|filesContaining)/);
    assert.ok(selected.has(file), `${file}: transitive packed-document consumer was omitted`);
  }
  // This stays selected as the supplied artifact evidence guard, not a claimed Markdown reader.
  const certification = await readFile(path.join(repo, "tests/package-certification.test.mjs"), "utf8");
  assert.match(certification, /verifyCertificationFixtureAllowlist/);
  assert.ok(selected.has("tests/package-certification.test.mjs"));
});
