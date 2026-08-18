import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * A guard that reports guarding and allows every write.
 *
 * A hook is a child process, and its working directory belongs to the client
 * that spawned it. Relative targets were resolved against *that* directory
 * instead of the session's own, which the payload states. Codex's `apply_patch`
 * names its files relative to the session, so those paths landed outside the
 * workspace, `resourceFor` returned null, the target list emptied, and every
 * write went through while `acc status` said `protection guarded`.
 *
 * It worked whenever a client happened to start its hooks in the project
 * directory, which is most of the time - and that is what kept it invisible.
 * Measured on the same claim, changing nothing but where the hook process
 * started: `exit 0` from one directory, `exit 2` from the other.
 */
async function repository(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-relative-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const bare = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) delete bare[name];
  const git = (...argv) => run("git", argv, { env: bare });

  const main = path.join(base, "repo");
  await git("-c", "init.defaultBranch=main", "init", "-q", main);
  await writeFile(path.join(main, "physics.mjs"), "export const y = 0;\n");
  await git("-C", main, "add", "-A");
  await git("-C", main, "-c", "user.email=a@b", "-c", "user.name=t",
    "commit", "-q", "-m", "init");
  const worktrees = {};
  for (const branch of ["graphics", "physics"]) {
    worktrees[branch] = path.join(base, "trees", branch);
    await git("-C", main, "worktree", "add", "-q", worktrees[branch], "-b", branch);
  }
  return { base, main, worktrees, env };
}

async function attach({ env }, participant, cwd) {
  const child = run(process.execPath, [hook, "codex"],
    { env: { ...env, ACC_PARTICIPANT: participant } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
    session_id: participant, cwd, source: "startup" }));
  await child;
}

/** A Codex `apply_patch`, whose targets are relative to the session. */
function patch(session, cwd, file) {
  return JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd,
    tool_name: "apply_patch",
    tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n`
      + "*** End Patch" } });
}

/** Run the guard with the hook process started in `from`, whatever that is. */
async function guard({ env }, { session, cwd, file, from }) {
  const child = run(process.execPath, [hook, "codex"],
    { env: { ...env, ACC_PARTICIPANT: session }, cwd: from });
  child.child.stdin.end(patch(session, cwd, file));
  return child.then(() => ({ decision: "allow", exitCode: 0 }),
    error => ({ decision: "deny", exitCode: error.code, stderr: error.stderr }));
}

const claim = ({ env }, cwd, resource) => run(process.execPath,
  [acc, "claim", "--resource", resource, "--enforcement", "guarded",
    "--reason", "editing", "--cwd", cwd], { env });

test("a claim is enforced wherever the hook process happens to start", async t => {
  const place = await repository(t);
  await attach(place, "graphics", place.worktrees.graphics);
  await attach(place, "physics", place.worktrees.physics);
  await claim(place, place.worktrees.graphics, "file:physics.mjs");

  // The client's cwd for the hook is not the session's. Nothing about the claim
  // changes; only where this process was started.
  const elsewhere = await guard(place, { session: "physics",
    cwd: place.worktrees.physics, file: "physics.mjs", from: place.base });

  assert.equal(elsewhere.decision, "deny",
    "the write was allowed, and status would still have said `protection guarded`");
  assert.equal(elsewhere.exitCode, 2);
  assert.match(elsewhere.stderr, /claimed by graphics/);
});

test("one worktree's claim reaches an agent in another", async t => {
  const place = await repository(t);
  await attach(place, "graphics", place.worktrees.graphics);
  await attach(place, "physics", place.worktrees.physics);
  await claim(place, place.worktrees.graphics, "file:physics.mjs");

  // Every worktree of a repository is one workspace, so a claim spans them. The
  // agents are in different directories on different branches; the file they
  // would both edit is the same file in the project, and one of them said so.
  const other = await guard(place, { session: "physics",
    cwd: place.worktrees.physics, file: "physics.mjs", from: place.worktrees.physics });

  assert.equal(other.decision, "deny");
  assert.match(other.stderr, /claimed by graphics/);
});

test("the claim holder is not blocked from its own claim", async t => {
  const place = await repository(t);
  await attach(place, "graphics", place.worktrees.graphics);
  await claim(place, place.worktrees.graphics, "file:physics.mjs");

  const own = await guard(place, { session: "graphics",
    cwd: place.worktrees.graphics, file: "physics.mjs", from: place.base });

  assert.equal(own.decision, "allow");
});

test("a session started in a subdirectory shares one name for one file", async t => {
  const place = await repository(t);
  const inner = path.join(place.worktrees.graphics, "src");
  await run("mkdir", ["-p", inner]);
  await attach(place, "graphics", place.worktrees.graphics);
  // Claimed before the second session exists: both are in this checkout, and
  // `acc` refuses to guess which of two live sessions is calling it.
  await claim(place, place.worktrees.graphics, "file:src/physics.mjs");
  await attach(place, "deep", inner);

  // `deep` calls it `physics.mjs`, `graphics` calls it `src/physics.mjs`, and it
  // is one file. Relativising to each session's own directory gave it two names
  // and a claim on either covered neither.
  const below = await guard(place, { session: "deep", cwd: inner,
    file: "physics.mjs", from: place.base });

  assert.equal(below.decision, "deny",
    "the same file has two names, so a claim on it protects nothing");
  assert.match(below.stderr, /claimed by graphics/);
});

test("a write outside the claim still goes through", async t => {
  const place = await repository(t);
  await attach(place, "graphics", place.worktrees.graphics);
  await attach(place, "physics", place.worktrees.physics);
  await claim(place, place.worktrees.graphics, "file:physics.mjs");

  // A guard observed only denying proves as little as one observed only
  // allowing: either alone is consistent with a guard that is simply stuck.
  const unrelated = await guard(place, { session: "physics",
    cwd: place.worktrees.physics, file: "render.mjs", from: place.base });

  assert.equal(unrelated.decision, "allow");
});
