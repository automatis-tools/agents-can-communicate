import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * One agent asking another to finish something.
 *
 * The point of the product, and for a long time the part with no way to invoke
 * it: the core could create workstreams, assign tasks and take them, and none
 * of the three was reachable from the CLI or from MCP.
 *
 * Driven through the binaries, in two git worktrees of one repository, because
 * that is the shape the work actually takes - each agent on its own branch,
 * ordering pieces from the others.
 */
async function project(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-request-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  await mkdir(main, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  // git must not inherit the emptied variables the suite exports.
  const bare = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) delete bare[name];
  const git = (...argv) => run("git", argv, { env: bare });

  await git("-c", "init.defaultBranch=main", "init", "-q", main);
  await git("-C", main, "-c", "user.email=a@b", "-c", "user.name=t",
    "commit", "-q", "--allow-empty", "-m", "init");
  const second = path.join(base, "tests-worktree");
  await git("-C", main, "worktree", "add", "-q", second, "-b", "tests");

  return { base, main, second, env };
}

async function attach({ env }, adapter, clientSessionId, cwd, participant = adapter) {
  // Named on launch. Without a name each running agent gets its own generated
  // one, which is what keeps two Codex sessions apart - but a test that wants
  // to address someone has to know what to call them, and so does a person.
  const named = { ...env, ACC_PARTICIPANT: participant };
  const child = run(process.execPath, [hook, adapter, "sessionStart"], { env: named });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
    session_id: clientSessionId, cwd, source: "startup" }));
  await child;
  const { stdout } = await run(process.execPath,
    [acc, "doctor", "--cwd", cwd, "--json"], { env: named });
  return loadSessionBinding({ runtimeDir: JSON.parse(stdout).data.runtimeRoot,
    harnessSessionId: clientSessionId });
}

async function turn({ env }, adapter, clientSessionId, cwd, participant = adapter) {
  const child = run(process.execPath, [hook, adapter, "userPromptSubmit"],
    { env: { ...env, ACC_PARTICIPANT: participant } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit",
    session_id: clientSessionId, cwd, prompt: "carry on" }));
  const { stdout } = await child;
  if (stdout.trim() === "") return "";
  if (!stdout.trimStart().startsWith("{")) return stdout;
  return JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
}

const cli = ({ env }, cwd, ...argv) =>
  run(process.execPath, [acc, ...argv, "--cwd", cwd], { env });

const tasksOf = async ({ env }, cwd, session) => JSON.parse((await run(process.execPath,
  [acc, "sync", "--session", session, "--scope", "full", "--cwd", cwd, "--json"],
  { env })).stdout).data.snapshot.tasks;

test("an agent in one worktree can ask an agent in another to finish something",
  async t => {
    const place = await project(t);
    const asker = await attach(place, "codex", "asker", place.main);
    await attach(place, "claude_code", "doer", place.second);

    const { stdout } = await cli(place, place.main, "request",
      "--session", asker.accSessionId, "--generation", asker.generation,
      "--to", "claude_code", "--title", "finish the store tests",
      "--detail", "I ran out of time on the concurrency cases.");

    assert.match(stdout, /requested task_.* of claude_code/);

    const shown = await turn(place, "claude_code", "doer", place.second);
    // Both halves reach them: the task as work waiting, the message as the
    // reason. Either alone leaves the recipient guessing - and the line carries
    // the task id, since every command that acts on it needs one.
    assert.match(shown, /\[task_unblocked\] task_\S+ finish the store tests/);
    assert.match(shown, /type work_request/);
    assert.match(shown, /I ran out of time on the concurrency cases\./);
  });

test("work outlives the session it was addressed to", async t => {
  // The reason a task names a participant rather than a session. The agent
  // closes its terminal before reading the request; the next session of that
  // same agent is still told about it.
  const place = await project(t);
  const asker = await attach(place, "codex", "asker", place.main);
  const first = await attach(place, "claude_code", "doer-1", place.second);

  await cli(place, place.main, "request",
    "--session", asker.accSessionId, "--generation", asker.generation,
    "--to", "claude_code", "--title", "finish the store tests");

  const child = run(process.execPath, [hook, "claude_code", "sessionEnd"], { env: place.env });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd",
    session_id: "doer-1", cwd: place.second, reason: "exit" }));
  await child;

  const second = await attach(place, "claude_code", "doer-2", place.second);
  assert.notEqual(second.accSessionId, first.accSessionId, "the same session came back");

  const shown = await turn(place, "claude_code", "doer-2", place.second);
  assert.match(shown, /\[task_unblocked\] task_\S+ finish the store tests/,
    "a restarted agent was never told about work waiting for it");
});

test("work addressed to one agent is not taken by another", async t => {
  const place = await project(t);
  const asker = await attach(place, "codex", "asker", place.main);
  await attach(place, "claude_code", "doer", place.second);
  const other = await attach(place, "kimi", "bystander", place.main);

  await cli(place, place.main, "request",
    "--session", asker.accSessionId, "--generation", asker.generation,
    "--to", "claude_code", "--title", "finish the store tests");
  const [task] = await tasksOf(place, place.main, asker.accSessionId);

  const refused = await cli(place, place.main, "task",
    "--session", other.accSessionId, "--generation", other.generation,
    "--task", task.taskId, "--take").catch(error => error);

  assert.equal(refused.code, 5, `expected a conflict, got: ${refused.stdout ?? refused}`);
  // Human mode keeps stdout clean and puts the reason on stderr.
  assert.match(refused.stderr, /addressed to another participant/);
});

test("taking a task records who is doing it without losing who it is for", async t => {
  const place = await project(t);
  const asker = await attach(place, "codex", "asker", place.main);
  const doer = await attach(place, "claude_code", "doer", place.second);

  await cli(place, place.main, "request",
    "--session", asker.accSessionId, "--generation", asker.generation,
    "--to", "claude_code", "--title", "finish the store tests");
  const [created] = await tasksOf(place, place.main, asker.accSessionId);

  await cli(place, place.second, "task", "--session", doer.accSessionId,
    "--generation", doer.generation, "--task", created.taskId, "--take");
  await cli(place, place.second, "task", "--session", doer.accSessionId,
    "--generation", doer.generation, "--task", created.taskId, "--state", "review");
  await cli(place, place.second, "task", "--session", doer.accSessionId,
    "--generation", doer.generation, "--task", created.taskId, "--state", "done");

  const [finished] = await tasksOf(place, place.main, asker.accSessionId);
  assert.equal(finished.state, "done");
  assert.equal(finished.assigneeParticipantId, "claude_code", "who it was for was lost");
  assert.equal(finished.assigneeSessionId, doer.accSessionId, "who did it was not recorded");
});

test("a task needs no workstream, and a named one has to exist", async t => {
  const place = await project(t);
  const asker = await attach(place, "codex", "asker", place.main);
  const owner = ["--session", asker.accSessionId, "--generation", asker.generation];

  // "Finish these tests for me" should not require inventing a project first.
  await cli(place, place.main, "task", ...owner, "--title", "standalone");
  const [loose] = await tasksOf(place, place.main, asker.accSessionId);
  assert.equal(loose.workstreamId, null);

  const invented = await cli(place, place.main, "task", ...owner,
    "--title", "hangs off nothing", "--workstream", "workstream_never_created")
    .catch(error => error);
  assert.equal(invented.code, 4, "a task attached itself to a workstream that does not exist");

  const { stdout } = await cli(place, place.main, "workstream", ...owner,
    "--title", "Storage", "--objective", "port the store and its tests");
  const workstreamId = stdout.trim().split(" ")[0];
  await cli(place, place.main, "task", ...owner,
    "--title", "inside a real one", "--workstream", workstreamId);
  const attached = (await tasksOf(place, place.main, asker.accSessionId))
    .find(task => task.title === "inside a real one");
  assert.equal(attached.workstreamId, workstreamId);
});
