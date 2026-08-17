import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gitProvenance } from "../../scripts/git-provenance.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * The revision half of a release record.
 *
 * `CHANGELOG.md` carries a tarball digest, and every workspace travels inside
 * that tarball - so any change to shipped code changes it. A digest recorded
 * without the commit it belongs to goes stale on the next merge and then reads
 * as a false claim about the current tree rather than a true one about an older
 * commit. This is the piece that makes the record checkable.
 */

/** Run with the git variables the suite and the release workflow both export. */
async function withGitEnv(overrides, callback) {
  const saved = new Map(Object.keys(overrides).map(name => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  try {
    return await callback();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a checkout reports the commit it is on", async () => {
  const { commit, why } = await gitProvenance(repo);

  assert.equal(why, undefined);
  assert.match(commit, /^[0-9a-f]{7,40}$/);
});

test("an inherited empty GIT_DIR does not silence the revision", async () => {
  // The regression this file exists for. `npm test` and the release workflow
  // both set GIT_DIR='' so that git inside temporary fixture repositories
  // cannot reach this checkout. To git that is a repository path of "", not an
  // unset variable, and every command fails with `not a git repository: ''`.
  //
  // The first version of this helper caught that and returned no commit, so the
  // evidence line vanished in exactly the environment the release doc
  // prescribes - silently, with a PASS still printed.
  const bare = await withGitEnv({ GIT_DIR: "", GIT_WORK_TREE: "" },
    () => gitProvenance(repo));

  assert.match(bare.commit ?? "", /^[0-9a-f]{7,40}$/,
    `the empty GIT_DIR was inherited: ${bare.why}`);
  assert.equal(bare.commit, (await gitProvenance(repo)).commit,
    "the answer changed with the environment");
});

test("a directory outside any checkout says so instead of guessing", async t => {
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "acc-provenance-")));
  t.after(() => rm(outside, { recursive: true, force: true }));

  // `GIT_CEILING_DIRECTORIES` stops discovery walking up into whatever
  // repository the temporary directory happens to sit under on this machine.
  const result = await withGitEnv({ GIT_CEILING_DIRECTORIES: path.dirname(outside) },
    () => gitProvenance(outside));

  assert.equal(result.commit, null);
  assert.equal(result.dirty, false);
  // Not a bare null: the caller prints this so an operator knows the record is
  // incomplete rather than assuming there was nothing to record.
  assert.equal(typeof result.why, "string");
  assert.equal(result.why.length > 0, true);
});

test("the dirty flag is a boolean the caller can trust", async () => {
  const { dirty } = await gitProvenance(repo);

  assert.equal(typeof dirty, "boolean");
});
