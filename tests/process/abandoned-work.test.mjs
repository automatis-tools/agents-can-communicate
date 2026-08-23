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
 * Somebody takes on a piece of work and never comes back.
 *
 * Every part of this was broken and silent. The task stayed `in_progress` with a
 * dead session on it forever, nobody else could take it - `the task already has
 * an assignee` - and the agent that asked was told nothing at all. A request
 * handed to an agent that closed its terminal simply disappeared, and blocked
 * the work for everyone else on the way out.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-abandon-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "game");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  return { project, env };
}

const named = (env, participant) => ({ ...env, ACC_PARTICIPANT: participant });

async function hookEvent({ env, project }, adapter, clientSessionId, participant,
  kind, payload) {
  const child = run(process.execPath, [hook, adapter, kind],
    { env: named(env, participant) });
  child.child.stdin.end(JSON.stringify({ session_id: clientSessionId, cwd: project,
    ...payload }));
  const { stdout } = await child;
  return stdout;
}

async function attach(place, adapter, clientSessionId, participant) {
  await hookEvent(place, adapter, clientSessionId, participant, "sessionStart",
    { hook_event_name: "SessionStart", source: "startup" });
  const { stdout } = await run(process.execPath,
    [acc, "doctor", "--cwd", place.project, "--json"], { env: place.env });
  return loadSessionBinding({ runtimeDir: JSON.parse(stdout).data.runtimeRoot,
    harnessSessionId: clientSessionId });
}

async function turn(place, adapter, clientSessionId, participant) {
  const stdout = await hookEvent(place, adapter, clientSessionId, participant,
    "userPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt: "go on" });
  if (stdout.trim() === "") return "";
  if (!stdout.trimStart().startsWith("{")) return stdout;
  return JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
}

const cli = ({ env, project }, ...argv) =>
  run(process.execPath, [acc, ...argv, "--cwd", project], { env });

const tasksOf = async (place, session) => JSON.parse((await run(process.execPath,
  [acc, "sync", "--session", session, "--scope", "full", "--cwd", place.project, "--json"],
  { env: place.env })).stdout).data.snapshot.tasks;

/** A request taken up by an agent that is about to disappear. */
async function inFlight(t) {
  const place = await workspace(t);
  const asker = await attach(place, "codex", "gfx", "graphics");
  const doer = await attach(place, "kimi", "phys", "physics");
  await cli(place, "request", "--session", asker.accSessionId,
    "--generation", asker.generation, "--to", "physics",
    "--title", "tank sinks into mud", "--detail", "Can you take this?");
  const [task] = await tasksOf(place, asker.accSessionId);
  await cli(place, "task", "--session", doer.accSessionId,
    "--generation", doer.generation, "--task", task.taskId, "--take");
  return { place, asker, doer, task };
}

test("closing a session hands back the work it was holding", async t => {
  const { place, asker, doer, task } = await inFlight(t);

  await hookEvent(place, "kimi", "phys", "physics", "sessionEnd",
    { hook_event_name: "SessionEnd", reason: "exit" });

  const [after] = await tasksOf(place, asker.accSessionId);
  assert.equal(after.taskId, task.taskId);
  assert.equal(after.state, "pending", "the work stayed locked to a session that had gone");
  assert.equal(after.assigneeSessionId, null);
  // Still addressed to that agent: the same one, restarted under the same name,
  // is exactly who should get it back.
  assert.equal(after.assigneeParticipantId, "physics");
  assert.notEqual(doer.accSessionId, null);
});

test("the agent waiting is told, even when it is the only session left", async t => {
  // The trap this used to fall into: with the worker gone the asker is alone,
  // and the "solo costs nothing" rule returned before the inbox was read - so
  // the one message that mattered was the one that got swallowed.
  const { place } = await inFlight(t);
  await hookEvent(place, "kimi", "phys", "physics", "sessionEnd",
    { hook_event_name: "SessionEnd", reason: "exit" });

  const shown = await turn(place, "codex", "gfx", "graphics");

  assert.match(shown, /\[request_stalled\] task_\S+ tank sinks into mud/,
    "the requester was left waiting with nothing said");
});

test("a stalled request keeps saying so until it is resolved", async t => {
  const { place } = await inFlight(t);
  await hookEvent(place, "kimi", "phys", "physics", "sessionEnd",
    { hook_event_name: "SessionEnd", reason: "exit" });

  const first = await turn(place, "codex", "gfx", "graphics");
  const second = await turn(place, "codex", "gfx", "graphics");

  // Unlike the one-shot answers a request produces, this is a standing fact.
  assert.match(first, /request_stalled/);
  assert.match(second, /request_stalled/, "the warning stopped while still true");
});

test("work held by a session that never said goodbye needs force to take", async t => {
  const { place, task } = await inFlight(t);
  // No sessionEnd: the crash case. Presence decays but nothing releases the
  // task, because an agent that has gone quiet may be thinking rather than dead.
  const other = await attach(place, "kimi", "phys2", "physics");

  const refused = await cli(place, "task", "--session", other.accSessionId,
    "--generation", other.generation, "--task", task.taskId, "--take")
    .catch(error => error);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /already has an assignee|gone quiet/);
});

test("declining returns the work and says why", async t => {
  const place = await workspace(t);
  const asker = await attach(place, "codex", "gfx", "graphics");
  const doer = await attach(place, "kimi", "phys", "physics");
  await cli(place, "request", "--session", asker.accSessionId,
    "--generation", asker.generation, "--to", "physics",
    "--title", "tank sinks into mud", "--detail", "Can you take this?");
  const [task] = await tasksOf(place, asker.accSessionId);

  await cli(place, "task", "--session", doer.accSessionId, "--generation", doer.generation,
    "--task", task.taskId, "--decline", "--reason", "Owned by the terrain pass.");

  const shown = await turn(place, "codex", "gfx", "graphics");
  assert.match(shown, /declined: tank sinks into mud/);
  assert.match(shown, /Owned by the terrain pass\./,
    "the refusal arrived without the reason for it");

  const [after] = await tasksOf(place, asker.accSessionId);
  // Back on the table rather than deleted: the work is still wanted, it is just
  // not this agent's.
  assert.equal(after.state, "pending");
  assert.equal(after.assigneeParticipantId, null);
});

test("accepting and finishing both answer the agent that asked", async t => {
  const { place, doer, task } = await inFlight(t);

  const accepted = await turn(place, "codex", "gfx", "graphics");
  assert.match(accepted, /accepted: tank sinks into mud/);

  await cli(place, "task", "--session", doer.accSessionId, "--generation", doer.generation,
    "--task", task.taskId, "--state", "done");
  const finished = await turn(place, "codex", "gfx", "graphics");

  assert.match(finished, /done: tank sinks into mud/,
    "the requester was never told the work was finished");
});

test("finishing the work answers the request it came from", async t => {
  // `acc request` marks its message as needing an acknowledgement, which raises
  // a `direct_request` item for the recipient. Nothing cleared it: the operation
  // existed in the core and was reachable from no surface, so every completed
  // request left a line repeating in the doer's turn for good. A live Claude
  // Code session reported exactly this and refused to clear it by hand, which
  // was the right call and left it stuck.
  const { place, doer, task } = await inFlight(t);

  const before = await turn(place, "kimi", "phys", "physics");
  assert.match(before, /\[direct_request\] message_\S+ tank sinks into mud/);

  await cli(place, "task", "--session", doer.accSessionId, "--generation", doer.generation,
    "--task", task.taskId, "--state", "done");
  const after = await turn(place, "kimi", "phys", "physics");

  assert.equal(after.includes("[direct_request]"), false,
    `the request kept asking after the work was done:\n${after}`);
});

test("declining answers it too", async t => {
  const { place, doer, task } = await inFlight(t);

  await cli(place, "task", "--session", doer.accSessionId, "--generation", doer.generation,
    "--task", task.taskId, "--decline", "--reason", "not mine");
  const after = await turn(place, "kimi", "phys", "physics");

  assert.equal(after.includes("[direct_request]"), false, after);
});

test("a message not tied to a task can be answered directly", async t => {
  const place = await workspace(t);
  const asker = await attach(place, "codex", "gfx", "graphics");
  const doer = await attach(place, "kimi", "phys", "physics");
  const { stdout } = await cli(place, "message", "--session", asker.accSessionId,
    "--generation", asker.generation, "--to", "physics", "--type", "question",
    "--subject", "scale", "--body", "Is the tank scale settled?", "--requires-ack");
  const messageId = stdout.trim().replace(/^sent /, "");

  assert.match(await turn(place, "kimi", "phys", "physics"),
    /\[direct_request\] message_\S+ scale/);
  await cli(place, "ack", "--session", doer.accSessionId, "--generation", doer.generation,
    "--message", messageId);

  const after = await turn(place, "kimi", "phys", "physics");
  assert.equal(after.includes("[direct_request]"), false, after);
});
