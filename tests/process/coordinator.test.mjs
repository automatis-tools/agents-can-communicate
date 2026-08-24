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
 * An attention item nobody could answer.
 *
 * Creating a workstream put `coordinator_missing` in every turn from that moment
 * on, and there was no way to clear it: `acquireCoordinator` and
 * `releaseCoordinator` existed in the core, were tested there, and had no
 * command and no tool. The register of surfaces said as much - "no workstream
 * coordination surface yet, tracked, not forgotten" - so this was a known gap
 * that had become a permanent nag in everyone's context.
 *
 * The project has fixed this exact shape twice: a `requiresAck` message raised
 * an item that `markDelivery` could not clear because it had no surface either,
 * and `nearby_intent` was an attention kind with no rule at all.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-coord-")));
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
  return { project, env, attach, turn, cli };
}

const workstreamId = async place => JSON.parse((await place.cli("workstream",
  "--title", "Storage", "--objective", "port the store and its tests")).stdout)
  .data.workstreamId;

test("an open workstream can be taken on, and then stops being reported", async t => {
  const place = await workspace(t);
  await place.attach("alpha");
  const workstream = await workstreamId(place);
  assert.match(await place.turn("alpha"), /\[coordinator_missing\]/,
    "nothing asked for a coordinator");

  await place.cli("workstream", "--workstream", workstream, "--take");

  assert.equal((await place.turn("alpha")).includes("coordinator_missing"), false,
    "the item stayed after somebody took the workstream on");
});

test("handing coordination back asks again", async t => {
  const place = await workspace(t);
  await place.attach("alpha");
  const workstream = await workstreamId(place);
  await place.cli("workstream", "--workstream", workstream, "--take");

  await place.cli("workstream", "--workstream", workstream, "--release");

  // The point of the item is that an open workstream with nobody steering it is
  // worth saying. Letting go has to bring it back or the release is a way to
  // silence it permanently.
  assert.match(await place.turn("alpha"), /\[coordinator_missing\]/);
});

test("only the coordinator may hand it back", async t => {
  const place = await workspace(t);
  await place.attach("alpha");
  // Created before the second session exists: two sessions in one checkout are
  // two candidates, and `acc` refuses to guess which of them is calling it.
  const workstream = await workstreamId(place);
  const alpha = JSON.parse((await place.cli("status")).stdout).data.participants
    .find(item => item.participantId === "alpha").sessionId;
  await place.cli("workstream", "--session", alpha, "--workstream", workstream, "--take");
  await place.attach("beta");

  const beta = JSON.parse((await place.cli("status")).stdout).data.participants
    .find(item => item.participantId === "beta").sessionId;
  const refused = await place.cli("workstream", "--session", beta,
    "--workstream", workstream, "--release").then(() => null, error => error);

  assert.notEqual(refused, null, "a peer handed back somebody else's lease");
  assert.match(JSON.parse(refused.stdout).error.message, /only the coordinator/);
});

test("taking or releasing needs to say which workstream", async t => {
  const place = await workspace(t);
  await place.attach("alpha");
  await workstreamId(place);

  const refused = await place.cli("workstream", "--take").then(() => null, error => error);

  assert.notEqual(refused, null);
  assert.match(JSON.parse(refused.stdout).error.message, /--take requires --workstream/);
});

test("creating one still needs a title and an objective", async t => {
  const place = await workspace(t);
  await place.attach("alpha");

  // Both became optional so the command could act on an existing workstream.
  // Optional in the parser is not optional in the command.
  const refused = await place.cli("workstream", "--title", "Storage")
    .then(() => null, error => error);

  assert.notEqual(refused, null, "a workstream was created with no objective");
  assert.match(JSON.parse(refused.stdout).error.message, /requires --objective/);
});
