import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const acc = path.join(path.resolve(import.meta.dirname, "..", ".."), "bin", "acc.mjs");

/**
 * Running `acc` where you live.
 *
 * A home directory is no checkout, so discovery falls back to the directory you
 * are in - and the platform's own state directory is inside a home by
 * definition. Every command that opens a workspace then refused, with a
 * sentence about runtime state that reads as a misconfiguration and names
 * nothing the reader can do.
 */
async function home(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "acc-home-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // No ACC_DATA_HOME, so the platform default applies - which is what a person
  // has. XDG is cleared for the same reason on Linux.
  const env = { ...process.env, HOME: directory, ACC_DATA_HOME: "", XDG_DATA_HOME: "",
    GIT_DIR: "", GIT_WORK_TREE: "" };
  return { directory, env };
}

test("the refusal names the directory, its state, and what to do", async t => {
  const place = await home(t);

  const failed = await run(process.execPath, [acc, "status", "--cwd", place.directory],
    { env: place.env }).then(() => null, error => error);

  assert.notEqual(failed, null, "a home directory was accepted as a workspace");
  assert.match(failed.stderr, new RegExp(place.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(failed.stderr, /cannot be a workspace/);
  assert.match(failed.stderr, /Run acc inside a project/);
  assert.match(failed.stderr, /ACC_DATA_HOME/);
  assert.doesNotMatch(failed.stderr, /must not live inside the workspace/,
    "the sentence written for a different reader is still the one printed");
});

test("the commands that describe the program still answer there", async t => {
  const place = await home(t);
  // `acc help` in the directory you are standing in should not be a usage
  // error, whatever that directory is.
  for (const command of ["help", "version"]) {
    const { stdout } = await run(process.execPath, [acc, command, "--cwd", place.directory],
      { env: place.env });
    assert.notEqual(stdout.trim(), "");
  }
});

test("a project inside that home works as it always did", async t => {
  const place = await home(t);
  const project = await mkdtemp(path.join(place.directory, "project-"));

  const { stdout } = await run(process.execPath,
    [acc, "status", "--cwd", project, "--json"], { env: place.env });

  assert.equal(JSON.parse(stdout).ok, true);
});
