import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * Writing a workspace config decouples everyone already in the workspace.
 *
 * The config carries its own `workspaceId`, which is the point: an identity that
 * survives the directory being moved or cloned. The cost is that writing one
 * moves the project to a *different* workspace, and sessions attached to the old
 * one go on heartbeating it. Measured before this refused: `1 live` before `acc
 * config init`, `0 live` after, with the session still running.
 *
 * Nothing recovers on its own. A session attaches at SessionStart and at no
 * other event; the next turn finds no binding for the new workspace and returns
 * empty. So the agents keep working, keep believing they are coordinating, and
 * are invisible to each other until their clients restart - which is the worst
 * possible failure for a tool whose whole job is that they are not.
 */
async function attached(t, { sessions }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-config-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await run("mkdir", ["-p", project]);
  const env = { ...process.env, ACC_DATA_HOME: path.join(root, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };

  for (const { participant, harness } of sessions) {
    const child = run("node", [hook, harness],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: `h-${participant}`, cwd: project, source: "startup" }));
    await child;
  }
  const cli = args => run("node", [acc, ...args, "--cwd", project], { env });
  const live = async () => JSON.parse(
    (await cli(["status", "--json"])).stdout).data.counts.live;
  return { project, cli, live };
}

test("init refuses while sessions are attached, and names them", async t => {
  const { cli, live } = await attached(t, { sessions: [
    { participant: "graphics", harness: "claude_code" },
    { participant: "physics", harness: "codex" }] });
  assert.equal(await live(), 2);

  const failure = await cli(["config", "init", "--yes"]).then(() => null, error => error);

  assert.notEqual(failure, null, "it wrote the config and orphaned two live sessions");
  assert.equal(failure.code, EXIT.CONFLICT);
  assert.match(failure.stderr, /2 session\(s\) are attached here/);
  assert.match(failure.stderr, /graphics \(claude_code\)/);
  assert.match(failure.stderr, /physics \(codex\)/);
  // `--yes` answers "may I write this file", which is not the question here.
  assert.equal(await live(), 2, "the workspace moved anyway");
});

test("--force writes it, because sometimes that is what you mean", async t => {
  const { cli, live } = await attached(t,
    { sessions: [{ participant: "solo", harness: "codex" }] });

  const { stdout } = await cli(["config", "init", "--yes", "--force"]);

  assert.match(stdout, /acc\.workspace\.json/);
  // The consequence is real and is now the caller's decision rather than a
  // surprise: this is the number the refusal exists to protect.
  assert.equal(await live(), 0);
});

test("with nobody attached it writes without ceremony", async t => {
  const { cli } = await attached(t, { sessions: [] });

  const { stdout } = await cli(["config", "init", "--yes"]);

  assert.match(stdout, /acc\.workspace\.json/);
});

test("validate still works where the workspace cannot be opened", async t => {
  const { cli } = await attached(t, { sessions: [] });

  // The probe `init` uses must not become a precondition of the command a
  // reader runs precisely because something is wrong.
  const { stdout } = await cli(["config", "validate", "--json"]);

  assert.equal(JSON.parse(stdout).ok, true);
});
