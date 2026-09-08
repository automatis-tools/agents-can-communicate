import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fixtureOwnerEnv } from "./fixture-owner.mjs";
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
export async function claimSpellingProject(t, { owner = "hook", hookEnv = {} } = {}) {
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

  const owners = {};
  if (owner === "cli") {
    // Rejected-resource tests exercise the CLI contract, without a hook budget.
    const attached = JSON.parse((await run(process.execPath,
      [acc, "attach", "--participant", "holder", "--cwd", root, "--json"], { env })).stdout).data;
    assert.equal(typeof attached.sessionId, "string", "claim fixture: CLI attach omitted its owner");
    assert.equal(typeof attached.generation, "string", "claim fixture: CLI attach omitted its generation");
    owners.holder = { ACC_SESSION: attached.sessionId, ACC_GENERATION: attached.generation };
  } else {
    assert.equal(owner, "hook");
    for (const participant of ["holder", "writer"]) {
      const child = run(process.execPath, [hook, "codex"],
        { env: { ...env, ...hookEnv, ACC_PARTICIPANT: participant } });
      child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
        session_id: participant, cwd: root, source: "startup" }));
      const result = await child;
      const prerequisite = `claim fixture: ${participant} SessionStart did not establish usable context`;
      assert.equal(result.stderr.trim(), "",
        `${prerequisite} (exit 0; stderr: ${result.stderr.trim().slice(0, 300)})`);
      try { owners[participant] = await fixtureOwnerEnv(env.ACC_DATA_HOME, participant); }
      catch (cause) { throw new Error(`${prerequisite}: missing exact owner binding`, { cause }); }
    }
  }
  const status = JSON.parse((await run(process.execPath,
    [acc, "status", "--cwd", root, "--json"], { env })).stdout).data;
  for (const [participant, credentials] of Object.entries(owners)) {
    assert.ok(status.participants.some(item => item.participantId === participant
      && item.sessionId === credentials.ACC_SESSION && item.presence !== "offline"),
    `claim fixture: ${participant} owner is not active`);
  }

  const claim = resource => run(process.execPath, [acc, "claim", "--cwd", root,
    "--session", owners.holder.ACC_SESSION, "--resource", resource,
    "--enforcement", "guarded", "--reason", "editing"],
  { env: { ...env, ...owners.holder } });

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

