import assert from "node:assert/strict";
import fs from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Every record read walked its directory from the store root twice, lstat and
// realpath per level: about a thousand calls a hook, 130 ms of one on
// windows-latest. A directory validated once is now known by its identity, and
// the same name is checked again with one lstat, which follows every ancestor:
// a swapped ancestor lands on another directory and takes the whole walk.
let resolutions = 0;
const original = fs.promises.realpath;
fs.promises.realpath = async (...args) => { resolutions += 1; return original(...args); };
syncBuiltinESMExports();
const { assertManagedDirectory } = await import("../src/safe-directory.mjs");

async function tree(t) {
  const root = await original(await mkdtemp(path.join(tmpdir(), "acc-validated-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const leaf = path.join(root, "state", "session");
  await mkdir(leaf, { recursive: true });
  return { root, leaf };
}

test("a directory validated once is checked again without resolving its path", async t => {
  const { root, leaf } = await tree(t);
  const first = await assertManagedDirectory(root, leaf);
  resolutions = 0;
  const again = await assertManagedDirectory(root, leaf);
  assert.equal(resolutions, 0, "the second check walked the path again");
  assert.equal(again.stat.ino, first.stat.ino);
  assert.equal(typeof again.stat.ino, "bigint", "an NTFS file id does not fit a double");
});

test("an ancestor replaced by a link is walked again, and refused", async t => {
  const { root, leaf } = await tree(t);
  await assertManagedDirectory(root, leaf);
  const state = path.join(root, "state");
  const elsewhere = path.join(path.dirname(root), `${path.basename(root)}-decoy`);
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await cp(state, elsewhere, { recursive: true });
  await rename(state, path.join(root, "state-parked"));
  await symlink(elsewhere, state, "junction");

  await assert.rejects(assertManagedDirectory(root, leaf),
    /not a real directory|escapes the canonical store root/);
});

test("a directory made again under the same name is walked again", async t => {
  const { root, leaf } = await tree(t);
  const first = await assertManagedDirectory(root, leaf);
  await rename(leaf, `${leaf}-aside`);
  await mkdir(leaf);
  resolutions = 0;
  const again = await assertManagedDirectory(root, leaf);
  assert.notEqual(again.stat.ino, first.stat.ino);
  assert.equal(resolutions > 0, true, "a new directory was taken on the old one's word");
});
