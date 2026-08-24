import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { needsRefresh } from "@agents-can-communicate/hook-runner";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * A session that is working, and looks dead to everyone.
 *
 * One of the four clients fires a heartbeat event. The comment beside the
 * cadence said the others "refresh on every turn instead", and they did not: a
 * session's `heartbeatAt` was written when it attached and never again. Three
 * minutes later - a cadence of 60 seconds, stale at three of them - it went
 * stale and stayed stale however hard it was working.
 *
 * Measured, with a peer that had accepted work and was doing it:
 *
 *   asker  stale
 *   doer   stale
 *   - [request_stalled] port the store - nobody is working on it
 *   - [request_stalled] port the store - doer is not here to answer
 *
 * Every roster showed every peer as stale, so the word stopped meaning
 * anything, and the one rule that depends on it told a requester the opposite of
 * the truth.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-beat-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const fire = async (participant, payload) => {
    const child = run(process.execPath, [hook, "codex"],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ session_id: participant, cwd: project, ...payload }));
    return (await child).stdout;
  };
  const attach = participant => fire(participant,
    { hook_event_name: "SessionStart", source: "startup" });
  const turn = participant => fire(participant,
    { hook_event_name: "UserPromptSubmit", prompt: "go" });
  const write = participant => fire(participant, { hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: x\n@@\n-a\n+b\n*** End Patch" } });
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project, "--json"],
    { env });
  const presence = async participant => JSON.parse((await cli("status")).stdout).data
    .participants.find(item => item.participantId === participant)?.presence;

  /** Every session record, aged as if nothing had been heard for this long. */
  const goQuiet = async minutes => {
    const stamp = new Date(Date.now() - minutes * 60_000).toISOString();
    const root = path.join(base, "data", "acc", "workspaces");
    for (const workspaceId of await readdir(root)) {
      for (const area of ["state", "ephemeral"]) {
        const dir = path.join(root, workspaceId, area, "session");
        for (const name of await readdir(dir).catch(() => [])) {
          const file = path.join(dir, name);
          const held = JSON.parse(await readFile(file, "utf8"));
          const record = held.record ?? held;
          record.heartbeatAt = stamp;
          await writeFile(file, `${JSON.stringify(held, null, 2)}\n`);
        }
      }
    }
  };
  return { project, env, attach, turn, write, cli, presence, goQuiet };
}

test("a turn is a sign of life", async t => {
  const place = await workspace(t);
  await place.attach("worker");
  await place.goQuiet(4);
  assert.equal(await place.presence("worker"), "stale");

  await place.turn("worker");

  assert.equal(await place.presence("worker"), "online",
    "a session that just took a turn still looked dead to its peers");
});

test("a long turn is a sign of life too", async t => {
  const place = await workspace(t);
  await place.attach("worker");
  await place.turn("worker");
  await place.goQuiet(4);

  // Half an hour of tool calls is one turn. A session working that hard should
  // not go stale in the middle of it.
  await place.write("worker");

  assert.equal(await place.presence("worker"), "online");
});

test("guarding a write is still a read when the session was heard from lately", async t => {
  const place = await workspace(t);
  await place.attach("worker");
  await place.turn("worker");
  const before = await readdir(path.join(place.project, "..", "data", "acc", "workspaces"))
    .then(([id]) => path.join(place.project, "..", "data", "acc", "workspaces", id))
    .then(async root => (await readFile(path.join(root, "ephemeral", "session",
      (await readdir(path.join(root, "ephemeral", "session")))[0]), "utf8")));

  await place.write("worker");
  await place.write("worker");

  // Written at most twice a cadence, so the common case costs nothing. Two
  // guarded writes moments apart must not each take the writer lock.
  const root = await readdir(path.join(place.project, "..", "data", "acc", "workspaces"))
    .then(([id]) => path.join(place.project, "..", "data", "acc", "workspaces", id));
  const after = await readFile(path.join(root, "ephemeral", "session",
    (await readdir(path.join(root, "ephemeral", "session")))[0]), "utf8");
  assert.equal(after, before, "a heartbeat was written for a session heard from seconds ago");
});

test("work in progress is not reported as going nowhere", async t => {
  const place = await workspace(t);
  await place.attach("asker");
  await place.attach("doer");
  const asker = JSON.parse((await place.cli("status")).stdout).data.participants
    .find(item => item.participantId === "asker").sessionId;
  await place.cli("request", "--session", asker, "--to", "doer", "--title", "port the store");
  const doer = JSON.parse((await place.cli("status")).stdout).data.participants
    .find(item => item.participantId === "doer").sessionId;
  const { snapshot } = JSON.parse((await place.cli("sync", "--session", asker,
    "--scope", "full")).stdout).data;
  await place.cli("task", "--session", doer, "--task", snapshot.tasks[0].taskId, "--take");
  await place.goQuiet(4);

  await place.turn("doer");

  // The rule reads presence, so a session that looks dead makes it say the
  // opposite of the truth about work somebody is doing right now.
  const shown = await place.turn("asker");
  assert.equal(shown.includes("nobody is working on it"), false, shown);
});

test("a session with no recorded sign of life gets one", async () => {
  const now = Date.now();

  // `heartbeatAt` is required by the schema, so an absent one cannot happen
  // today. The point is that the decision does not rest on how `Date.parse`
  // treats something that is not a timestamp - it used to, and got the right
  // answer by accident.
  assert.equal(needsRefresh(undefined, now), true);
  assert.equal(needsRefresh("not a date", now), true);
  assert.equal(needsRefresh(new Date(now - 5_000).toISOString(), now), false);
  assert.equal(needsRefresh(new Date(now - 120_000).toISOString(), now), true);
});
