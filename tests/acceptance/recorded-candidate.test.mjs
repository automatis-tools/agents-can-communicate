import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * The recorded measurement has to describe something that can be built.
 *
 * The changelog names a commit and the digest of the tarball built from it, and
 * points a reader at `scripts/verify-package.mjs` to check. Every change to
 * shipped code invalidates it, and it went stale four times in a row before
 * anyone noticed - each time caught by hand, and each time only because someone
 * happened to run the script.
 *
 * A stale digest is worse than none: a reader who checks it and gets a different
 * number learns nothing except that the project's own evidence does not hold.
 *
 * What is compared is history rather than a fresh digest. Re-packing here would
 * be the stronger check and is not portable: a gzip stream carries mtimes, and
 * the CI matrix builds on two platforms.
 */
const PACKED = Object.freeze([
  "bin/",
  "packages/",
  "docs/ADAPTER_AUTHORING.md",
  "docs/ARCHITECTURE.md",
  "docs/CAPABILITIES.md",
  "docs/CLI.md",
  "docs/CONCEPTS.md",
  "docs/CONFIGURATION.md",
  "docs/DESIGN_DECISIONS.md",
  "docs/GETTING_STARTED.md",
  "docs/GLOSSARY.md",
  "docs/MCP.md",
  "docs/PROTOCOL.md",
  "docs/RELEASING.md",
  "docs/SECURITY_MODEL.md",
  "docs/TROUBLESHOOTING.md",
  "docs/WHY_ACC.md",
  "docs/index.md",
  "SECURITY.md",
  "README.md",
  "LICENSE",
  "package.json",
]);

// npm packs these whatever `files` says, which is why `files` cannot be the
// whole answer: the manifest always travels, and the bundled workspaces come
// from the dependency list. `package.json` was missing from the list above, so
// editing the manifest - a version bump, `npm pkg fix` - changed the digest
// while this file reported the record still described the tree.
const UNDECLARED = Object.freeze(["packages/", "package.json"]);

const git = async (...argv) => {
  const env = { ...process.env };
  // Inherited from a hook or a test runner, these describe someone else's
  // repository. The provenance script strips them for the same reason.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) delete env[name];
  return (await run("git", argv, { cwd: repo, env })).stdout;
};

test("the changelog's digest describes the code that is here now", async () => {
  const changelog = await readFile(path.join(repo, "CHANGELOG.md"), "utf8");
  const [, recorded] = /\|\s*Built from\s*\|\s*`([0-9a-f]{7,40})`\s*\|/.exec(changelog) ?? [];
  assert.equal(typeof recorded, "string", "the changelog records no commit");

  // A shallow clone - which is what `actions/checkout` makes by default - may
  // not have the recorded commit at all. Saying so is honest; failing would make
  // this a test of the checkout depth rather than of the record.
  const known = await git("cat-file", "-e", `${recorded}^{commit}`)
    .then(() => true, () => false);
  if (!known) {
    console.log(`recorded commit ${recorded} is not in this clone; nothing to compare`);
    return;
  }

  // Commits, and the working tree beside them. Comparing only commits meant
  // `npm test` passed on an edited README and the pre-push hook caught it a
  // moment later - the right answer at the wrong time, when the fix is a
  // re-record and the commit is already made.
  const changed = [...new Set([
    ...(await git("diff", "--name-only", `${recorded}..HEAD`, "--", ...PACKED)).split("\n"),
    ...(await git("status", "--porcelain", "--", ...PACKED))
      .split("\n").map(line => line.slice(3)),
  ])].filter(Boolean).sort();

  assert.deepEqual(changed, [],
    `shipped code changed since ${recorded}, so the recorded digest describes nothing `
    + "that can be built. Re-record with `node scripts/verify-package.mjs`:"
    + `\n  ${changed.join("\n  ")}`);
});

test("the packed set this checks is the packed set that ships", async () => {
  const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));

  // The list above is a copy, and a copy drifts. `packages/` stands in for every
  // bundled workspace, which npm packs from the dependency list rather than
  // from `files`.
  //
  const declared = new Set(manifest.files);
  for (const entry of PACKED) {
    if (UNDECLARED.includes(entry)) continue;
    assert.equal(declared.has(entry), true, `${entry} is no longer published`);
  }
  for (const entry of declared) {
    assert.equal(PACKED.includes(entry), true,
      `${entry} is published and this test would not notice it changing`);
  }
  assert.equal((manifest.bundleDependencies ?? []).length > 0, true,
    "nothing is bundled, so `packages/` no longer stands for anything shipped");
});

test("nothing reaches the tarball that this file would not notice changing", async () => {
  // Asks npm what it would pack rather than reading `files` and reasoning about
  // it. `--dry-run` writes nothing and answers in a fifth of a second, and it is
  // the only account of the tarball that cannot drift from the tarball.
  //
  // Listing entries is portable in a way comparing digests is not: a gzip stream
  // carries mtimes, and the CI matrix builds on two platforms.
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], { cwd: repo });
  const [packed] = JSON.parse(stdout);
  // Bundled workspaces arrive under `node_modules/` and are built from
  // `packages/`, which the list above already watches.
  const bundled = "node_modules/@agents-can-communicate/";

  const unwatched = packed.files.map(file => file.path)
    .filter(entry => !entry.startsWith(bundled))
    .filter(entry => !PACKED.some(watched => (watched.endsWith("/")
      ? entry.startsWith(watched) : entry === watched)))
    .sort();

  assert.deepEqual(unwatched, [],
    "these travel in the tarball and nothing above watches them, so a change to "
    + "one would leave the recorded digest describing a tarball nobody can build:"
    + `\n  ${unwatched.join("\n  ")}`);
});
