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
const PACKED = Object.freeze(["bin/", "packages/", "README.md", "LICENSE",
  "docs/CAPABILITIES.md"]);

const git = async (...argv) => {
  const env = { ...process.env };
  // Inherited from a hook or a test runner, these describe someone else's
  // repository. The provenance script strips them for the same reason.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) delete env[name];
  return (await run("git", argv, { cwd: repo, env })).stdout.trim();
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

  const changed = (await git("diff", "--name-only", `${recorded}..HEAD`, "--", ...PACKED))
    .split("\n").filter(Boolean);

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
  const declared = new Set(manifest.files);
  for (const entry of PACKED) {
    if (entry === "packages/") continue;
    assert.equal(declared.has(entry), true, `${entry} is no longer published`);
  }
  for (const entry of declared) {
    assert.equal(PACKED.includes(entry), true,
      `${entry} is published and this test would not notice it changing`);
  }
  assert.equal((manifest.bundleDependencies ?? []).length > 0, true,
    "nothing is bundled, so `packages/` no longer stands for anything shipped");
});
