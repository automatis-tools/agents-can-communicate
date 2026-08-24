import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * The last thing a session says.
 *
 * `acc finish --to physics` is the project's own end-of-session vocabulary: what
 * this was for, how far it got, what is left, what is in the way. It wrote a
 * durable handoff record and reported success, and the agent it named learned
 * nothing - not from their turn, not from their attention, not from `acc
 * status`. The record existed only in a full snapshot they would have had to
 * scan for their own name.
 *
 * The message type for announcing one has been in the protocol from the start
 * and nothing ever sent it. This is that half.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-handoff-")));
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
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project, "--json"],
    { env });
  const sessionOf = async participant => JSON.parse((await cli("status")).stdout).data
    .participants.find(item => item.participantId === participant).sessionId;
  return { project, env, attach, turn, cli, sessionOf };
}

test("a handoff reaches the agent it names", async t => {
  const place = await workspace(t);
  await place.attach("leaving");
  await place.attach("successor");
  const leaving = await place.sessionOf("leaving");

  await place.cli("finish", "--session", leaving, "--to", "successor",
    "--goal", "port the material slots", "--status", "partial",
    "--completed", "slots ported", "--remaining", "physics review",
    "--blocker", "waiting on the clamp decision");

  const shown = await place.turn("successor");
  assert.match(shown, /handing over: port the material slots/,
    `the successor was told nothing:\n${shown}`);
  // In the order a successor needs it: what it was for, how far it got, what is
  // left, and what is in the way.
  assert.match(shown, /partial/);
  assert.match(shown, /done:\n- slots ported/);
  assert.match(shown, /still to do:\n- physics review/);
  assert.match(shown, /in the way:\n- waiting on the clamp decision/);
});

test("a handoff says which claims it let go of", async t => {
  const place = await workspace(t);
  await place.attach("leaving");
  await place.attach("successor");
  const leaving = await place.sessionOf("leaving");
  await place.cli("claim", "--session", leaving, "--resource", "file:src/**",
    "--reason", "porting");

  await place.cli("finish", "--session", leaving, "--to", "successor",
    "--goal", "port the material slots");

  // What was released is what the successor is now free to take, which is the
  // part of a handoff they can act on immediately.
  assert.match(await place.turn("successor"), /released:\n- file:src\/\*\*/);
});

test("handing over to a name nobody has is refused", async t => {
  const place = await workspace(t);
  await place.attach("leaving");
  await place.attach("successor");
  const leaving = await place.sessionOf("leaving");

  const refused = await place.cli("finish", "--session", leaving, "--to", "sucessor",
    "--goal", "typo").then(() => null, error => error);

  // The summary is the last thing this session will ever say, so a mistyped
  // successor is the worst moment to be quiet about it.
  assert.notEqual(refused, null, "a session handed its work to nobody");
  assert.match(JSON.parse(refused.stdout).error.message, /no participant here is called sucessor/);
});

test("finishing without naming anyone is still finishing", async t => {
  const place = await workspace(t);
  await place.attach("leaving");
  const leaving = await place.sessionOf("leaving");
  await place.cli("claim", "--session", leaving, "--resource", "file:src/**",
    "--reason", "porting");

  const { stdout } = await place.cli("finish", "--session", leaving,
    "--goal", "port the material slots");

  // A session that ends without a successor still records what it did and lets
  // go of what it held. Only the announcement needs somebody to announce to.
  assert.equal(JSON.parse(stdout).ok, true);
  const status = JSON.parse((await place.cli("status")).stdout).data;
  assert.deepEqual(status.claims, []);
});
