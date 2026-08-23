import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * A claim is a string, and a file has many spellings.
 *
 * `src/a.mjs`, `./src/a.mjs`, `src//a.mjs`, `src/x/../a.mjs` name one file, and
 * on the filesystem this project is certified on so does `src/A.mjs`. None of
 * them matched the others. The claim was taken, `acc status` reported
 * `protection guarded`, and the write went through - the same silent-allow as
 * the symlink and the relative-target defects, arrived at from the claim side
 * instead of the target side.
 */
async function project(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-spelling-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const bare = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) delete bare[name];

  const root = path.join(base, "repo");
  await run("mkdir", ["-p", path.join(root, "src")]);
  await writeFile(path.join(root, "src", "physics.mjs"), "export const y = 0;\n");
  await run("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env: bare });
  await run("git", ["-C", root, "add", "-A"], { env: bare });
  await run("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=t",
    "commit", "-q", "-m", "init"], { env: bare });

  for (const participant of ["holder", "writer"]) {
    const child = run(process.execPath, [hook, "codex"],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: participant, cwd: root, source: "startup" }));
    await child;
  }
  const status = JSON.parse((await run(process.execPath,
    [acc, "status", "--cwd", root, "--json"], { env })).stdout).data;
  const holder = status.participants.find(item => item.participantId === "holder");

  const claim = resource => run(process.execPath, [acc, "claim", "--cwd", root,
    "--session", holder.sessionId, "--resource", resource,
    "--enforcement", "guarded", "--reason", "editing"], { env });

  const write = file => {
    const child = run(process.execPath, [hook, "codex"],
      { env: { ...env, ACC_PARTICIPANT: "writer" }, cwd: base });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse",
      session_id: "writer", cwd: root, tool_name: "apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n`
        + "*** End Patch" } }));
    return child.then(() => "allow", () => "deny");
  };
  return { root, env, claim, write };
}

/** Whether this filesystem treats two spellings as one file. Asked, not assumed. */
async function caseInsensitive(root) {
  return stat(path.join(root, "src", "PHYSICS.mjs")).then(() => true, () => false);
}

for (const spelling of ["file:./src/physics.mjs", "file:src//physics.mjs",
  "file:src/x/../physics.mjs"]) {
  test(`a claim written as ${spelling} still covers the file`, async t => {
    const place = await project(t);
    await place.claim(spelling);

    assert.equal(await place.write("src/physics.mjs"), "deny",
      "the claim was taken and protected nothing");
  });
}

test("the claim is stored under the one name, whatever it was typed as", async t => {
  const place = await project(t);

  const { stdout } = await place.claim("file:./src//physics.mjs");

  // What is echoed back is what a peer will see in `acc status`, so a claim that
  // reads differently from the file everyone else names is a claim nobody can
  // reason about.
  assert.match(stdout, /^claimed file:src\/physics\.mjs$/m);
});

test("case follows the filesystem, because that is what decides it", async t => {
  const place = await project(t);
  const merged = await caseInsensitive(place.root);
  await place.claim("file:src/Physics.mjs");

  const decision = await place.write("src/physics.mjs");

  // Where the two spellings are one file, a claim on either has to cover both.
  // Where they are two files, they are two resources and must stay so. No case
  // rule appears anywhere in ACC: `realpath` answers it on each machine.
  assert.equal(decision, merged ? "deny" : "allow",
    merged
      ? "one file on this filesystem, and the claim covered only one spelling"
      : "two files on this filesystem, and a claim on one blocked the other");
});

test("a glob keeps its meaning through normalisation", async t => {
  const place = await project(t);
  await place.claim("file:./src/**");

  assert.equal(await place.write("src/physics.mjs"), "deny");
  assert.equal(await place.write("README.md"), "allow");
});

for (const [spelling, expected] of [
  ["file:src", /is a directory; claim file:src\/\*\* to cover/],
  ["file:src/", /is a directory; claim file:src\/\*\* to cover/],
  ["file:src/*.mjs", /matches nothing: only a trailing \/\*\* is understood/],
  ["file:src/*", /matches nothing: only a trailing \/\*\* is understood/],
]) {
  test(`${spelling} is refused rather than stored as protection`, async t => {
    const place = await project(t);

    // Each of these was accepted, stored, and reported as `protection guarded`
    // while covering nothing at all. The claim was useless either way; refusing
    // is how its author finds out.
    const failure = await place.claim(spelling).then(() => null, error => error);

    assert.notEqual(failure, null, `${spelling} was stored and protects nothing`);
    assert.match(failure.stderr, expected);
  });
}

test("a path that does not exist yet can still be claimed", async t => {
  const place = await project(t);

  // Claiming before creating is the point of a claim, so an absent path is not
  // evidence of a mistake the way a directory is.
  const { stdout } = await place.claim("file:src/renderer.mjs");

  assert.match(stdout, /claimed file:src\/renderer\.mjs/);
});

test("a resource that is not a file is left exactly as it is", async t => {
  const place = await project(t);

  // Other schemes are opaque identifiers. Rewriting one would be inventing
  // meaning ACC does not have.
  const { stdout } = await place.claim("url:https://example.test/./a//b");

  assert.match(stdout, /claimed url:https:\/\/example\.test\/\.\/a\/\/b/);
});
