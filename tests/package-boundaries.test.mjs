// The core must stay project- and vendor-agnostic. This scan is the continuous
// guard for that rule: it fails on a forbidden import, on Papercut vocabulary,
// and - deliberately - on a target that does not exist or holds no modules, so
// the test cannot pass vacuously while the package is still empty.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN_SPECIFIERS = [
  { pattern: /^(?:node:)?child_process$/, reason: "spawns processes" },
  { pattern: /adapter-/, reason: "imports a harness adapter" },
  { pattern: /(?:^|\/)prototype\//, reason: "imports the Papercut prototype" },
  { pattern: /\.\.\/\.\.\/\.\.\//, reason: "reaches outside its package" },
];

const FORBIDDEN_TOKENS = [
  { pattern: /PW2_/, reason: "Papercut environment variable" },
  { pattern: /papercut/i, reason: "Papercut project name" },
  { pattern: /papercut-warzone/i, reason: "Papercut repository name" },
];

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
];

async function moduleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...await moduleFiles(item));
    } else if (entry.name.endsWith(".mjs")) {
      files.push(item);
    }
  }
  return files;
}

function specifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

export async function scanImports(packageDirectory, root = repoRoot) {
  const directory = path.join(root, packageDirectory);
  let files;
  try {
    files = await moduleFiles(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [{ file: packageDirectory, detail: "package directory does not exist" }];
  }
  if (files.length === 0) {
    return [{ file: packageDirectory, detail: "package directory contains no modules" }];
  }

  const violations = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    const source = await readFile(file, "utf8");
    // Import rules constrain what ships. Tests are not shipped and legitimately
    // reach the repository's shared helpers, so they are held to the vocabulary
    // rules only. Widening the import rules to tests would force either a
    // duplicated helper per package or a weaker rule for src.
    const shipped = relative.includes(`${path.sep}src${path.sep}`);
    if (shipped) {
      for (const specifier of specifiers(source)) {
        const rule = FORBIDDEN_SPECIFIERS.find(item => item.pattern.test(specifier));
        if (rule !== undefined) {
          violations.push({ file: relative, detail: `${specifier} ${rule.reason}` });
        }
      }
    }
    for (const rule of FORBIDDEN_TOKENS) {
      if (rule.pattern.test(source)) {
        violations.push({ file: relative, detail: rule.reason });
      }
    }
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file)
    || left.detail.localeCompare(right.detail));
}

test("core does not import adapters, git, or project-specific modules", async () => {
  const violations = await scanImports("packages/core");
  assert.deepEqual(violations, []);
});

test("protocol stays free of vendor and project vocabulary", async () => {
  const violations = await scanImports("packages/protocol");
  assert.deepEqual(violations, []);
});

async function fixtureRoot(t, modules = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "acc-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(modules)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  return root;
}

test("the scanner reports a missing package directory", async t => {
  const root = await fixtureRoot(t);
  assert.deepEqual(await scanImports("fixture", root),
    [{ file: "fixture", detail: "package directory does not exist" }]);
});

test("the scanner reports an existing directory with no modules", async t => {
  const root = await fixtureRoot(t, {
    "fixture/src/README.md": "No source modules yet.\n",
    "fixture/node_modules/vendor/index.mjs": "export const value = 1;\n",
  });
  assert.deepEqual(await scanImports("fixture", root),
    [{ file: "fixture", detail: "package directory contains no modules" }]);
});

test("the scanner permits source imports and exempts test imports", async t => {
  const root = await fixtureRoot(t, {
    "fixture/src/nested/valid.mjs": `
      import { readFile } from "node:fs/promises";
      import "../../shared.mjs";
      await import("@agents-can-communicate/protocol");
    `,
    "fixture/test/imports.mjs": `
      import { execFile } from "node:child_process";
      import "child_process";
      import "adapter-example";
      await import("./prototype/worker.mjs");
      import "../../../tests/helper.mjs";
    `,
    "fixture/src/ignored.js": 'import "node:child_process"; const name = "PW2_papercut-warzone";',
    "fixture/src/notes.txt": 'import "adapter-example"; const name = "PW2_papercut-warzone";',
    "fixture/src/node_modules/vendor/index.mjs": 'import "node:child_process"; const name = "PW2_papercut-warzone";',
  });
  assert.deepEqual(await scanImports("fixture", root), []);
});

test("the scanner reports forbidden source imports in sorted nested-file order", async t => {
  const root = await fixtureRoot(t, {
    "fixture/src/z.mjs": `
      import { execFile } from "node:child_process";
      import "child_process";
      await import("../../../tests/helper.mjs");
    `,
    "fixture/src/nested/a.mjs": `
      import "adapter-example";
      await import("./prototype/worker.mjs");
    `,
  });
  assert.deepEqual(await scanImports("fixture", root), [
    { file: path.join("fixture", "src", "nested", "a.mjs"), detail: "./prototype/worker.mjs imports the Papercut prototype" },
    { file: path.join("fixture", "src", "nested", "a.mjs"), detail: "adapter-example imports a harness adapter" },
    { file: path.join("fixture", "src", "z.mjs"), detail: "../../../tests/helper.mjs reaches outside its package" },
    { file: path.join("fixture", "src", "z.mjs"), detail: "child_process spawns processes" },
    { file: path.join("fixture", "src", "z.mjs"), detail: "node:child_process spawns processes" },
  ]);
});

test("the scanner reports all vocabulary rules in source and test modules", async t => {
  const root = await fixtureRoot(t, {
    "fixture/src/vocabulary.mjs": 'export const name = "PW2_PaPeRcUt-WaRzOnE";\n',
    "fixture/test/vocabulary.mjs": 'export const name = "PW2_PaPeRcUt-WaRzOnE";\n',
  });
  assert.deepEqual(await scanImports("fixture", root), [
    { file: path.join("fixture", "src", "vocabulary.mjs"), detail: "Papercut environment variable" },
    { file: path.join("fixture", "src", "vocabulary.mjs"), detail: "Papercut project name" },
    { file: path.join("fixture", "src", "vocabulary.mjs"), detail: "Papercut repository name" },
    { file: path.join("fixture", "test", "vocabulary.mjs"), detail: "Papercut environment variable" },
    { file: path.join("fixture", "test", "vocabulary.mjs"), detail: "Papercut project name" },
    { file: path.join("fixture", "test", "vocabulary.mjs"), detail: "Papercut repository name" },
  ]);
});
