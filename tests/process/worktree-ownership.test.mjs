import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * Which checkout each agent is working in.
 *
 * One workspace spans every worktree of a repository - that is what lets agents
 * on different branches see each other - so the workspace id cannot say who is
 * where. Nothing recorded it either: a session carried thirteen fields and not
 * one named a location, so "clean up the worktrees" had no way to tell an
 * abandoned checkout from someone's desk.
 *
 * Asking the room does not answer it. The agents worth asking about are the ones
 * that are not running, and they cannot reply.
 */
async function repository(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-worktree-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const bare = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) delete bare[name];
  const git = (...argv) => run("git", argv, { env: bare });

  const main = path.join(base, "repo");
  await git("-c", "init.defaultBranch=main", "init", "-q", main);
  await git("-C", main, "-c", "user.email=a@b", "-c", "user.name=t",
    "commit", "-q", "--allow-empty", "-m", "init");
  const worktrees = {};
  for (const branch of ["feature-a", "feature-b", "abandoned"]) {
    worktrees[branch] = path.join(base, "trees", branch);
    await git("-C", main, "worktree", "add", "-q", worktrees[branch], "-b", branch);
  }
  return { base, main, worktrees, env };
}

async function attach({ env }, participant, cwd) {
  const child = run(process.execPath, [hook, "codex", "sessionStart"],
    { env: { ...env, ACC_PARTICIPANT: participant } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
    session_id: participant, cwd, source: "startup" }));
  await child;
}

const roster = async ({ env }, cwd) => JSON.parse((await run(process.execPath,
  [acc, "status", "--cwd", cwd, "--json"], { env })).stdout).data.participants;

test("the roster says which checkout each agent is working in", async t => {
  const place = await repository(t);
  await attach(place, "alpha", place.worktrees["feature-a"]);
  await attach(place, "beta", place.worktrees["feature-b"]);
  await attach(place, "cleaner", place.main);

  const seen = await roster(place, place.main);
  const byName = Object.fromEntries(seen.map(item => [item.participantId, item]));

  assert.equal(byName.alpha.branch, "feature-a");
  assert.equal(byName.beta.branch, "feature-b");
  assert.equal(byName.cleaner.branch, "main");
  assert.equal(await realpath(byName.alpha.checkoutRoot),
    await realpath(place.worktrees["feature-a"]));
});

test("a checkout nobody is working in has no owner in the roster", async t => {
  const place = await repository(t);
  await attach(place, "alpha", place.worktrees["feature-a"]);
  await attach(place, "cleaner", place.main);

  const owned = new Set();
  for (const item of await roster(place, place.main)) {
    if (item.presence !== "offline") owned.add(await realpath(item.checkoutRoot));
  }
  const orphans = [];
  for (const [branch, dir] of Object.entries(place.worktrees)) {
    if (!owned.has(await realpath(dir))) orphans.push(branch);
  }

  // Exactly the two nobody opened. This is the whole answer to "clean up the
  // worktrees", and it is a read rather than a conversation.
  assert.deepEqual(orphans.sort(), ["abandoned", "feature-b"]);
});

test("worktrees of one repository share a workspace, other projects do not",
  async t => {
    const place = await repository(t);
    const other = path.join(place.base, "unrelated");
    const bare = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) delete bare[name];
    await run("git", ["-c", "init.defaultBranch=main", "init", "-q", other], { env: bare });
    await run("git", ["-C", other, "-c", "user.email=a@b", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "init"], { env: bare });

    await attach(place, "alpha", place.worktrees["feature-a"]);
    await attach(place, "stranger", other);

    const here = (await roster(place, place.main)).map(item => item.participantId);
    const there = (await roster(place, other)).map(item => item.participantId);

    // The boundary is the repository, not the machine. Joining every session on
    // a computer would put other people's projects in this roster.
    assert.deepEqual(here.sort(), ["alpha"]);
    assert.deepEqual(there, ["stranger"]);
  });

test("a peer is named in the turn context by something you can address",
  async t => {
    const place = await repository(t);
    await attach(place, "alpha", place.worktrees["feature-a"]);
    await attach(place, "cleaner", place.main);

    const child = run(process.execPath, [hook, "codex", "userPromptSubmit"],
      { env: { ...place.env, ACC_PARTICIPANT: "cleaner" } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit",
      session_id: "cleaner", cwd: place.main, prompt: "go on" }));
    const { stdout } = await child;

    // A session id cannot be used with `--to`. The roster line used to carry
    // one, so an agent reading its own turn could see that someone was there
    // and had no way to say anything to them.
    assert.match(stdout, /alpha on feature-a/);
  });
