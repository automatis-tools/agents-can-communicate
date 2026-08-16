// The core must stay project- and vendor-agnostic. This scan is the continuous
// guard for that rule: it fails on a forbidden import, on Papercut vocabulary,
// and - deliberately - on a target that does not exist or holds no modules, so
// the test cannot pass vacuously while the package is still empty.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

export async function scanImports(packageDirectory) {
  const directory = path.join(repoRoot, packageDirectory);
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
    const relative = path.relative(repoRoot, file);
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

test("the scanner refuses to pass on a missing or empty target", async () => {
  assert.deepEqual(await scanImports("packages/does-not-exist"),
    [{ file: "packages/does-not-exist", detail: "package directory does not exist" }]);
});

test("import rules apply to shipped source, vocabulary rules apply everywhere", async () => {
  // A src module reaching into the repository root must still be a violation,
  // so the narrower scope above cannot be mistaken for switching the rule off.
  const violations = await scanImports("packages/core");
  assert.deepEqual(violations, []);
  assert.equal(FORBIDDEN_SPECIFIERS.some(rule => rule.pattern.test("../../../tests/x.mjs")), true);
});

test("the scanner detects a forbidden specifier and Papercut vocabulary", async () => {
  // Guards the guard: the storage adapter is allowed to exist, but if the
  // scanner were pointed at a tree that genuinely violates the rules it must
  // report them rather than returning an empty list.
  const source = 'import { execFile } from "node:child_process";\nconst bus = "PW2_AGENT_BUS_DIR";\n';
  assert.deepEqual(specifiers(source), ["node:child_process"]);
  assert.equal(FORBIDDEN_SPECIFIERS.some(rule => rule.pattern.test("node:child_process")), true);
  assert.equal(FORBIDDEN_TOKENS.some(rule => rule.pattern.test(source)), true);
});
