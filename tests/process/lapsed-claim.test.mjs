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
 * A claim that ran out while its owner was still working.
 *
 * A lease lapses on the clock and nothing said so. Measured: while it held, a
 * peer's write into the file was refused; three seconds later the same write
 * went through, and the holder's turn was identical before and after. It went on
 * working on a file it believed it had reserved, while everyone else was free to
 * change it - the guard doing exactly what it was told, and the one agent who
 * needed to know being the only one not told.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-lapsed-")));
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
  const lapse = () => new Promise(resolve => { setTimeout(resolve, 2100); });
  return { project, env, attach, turn, cli, sessionOf, lapse };
}

test("the owner is told when its claim runs out", async t => {
  const place = await workspace(t);
  await place.attach("holder");
  await place.cli("claim", "--resource", "file:src/x.mjs", "--reason", "editing",
    "--lease", "2");
  assert.equal((await place.turn("holder")).includes("claim_expired"), false,
    "reported before the lease had run out");

  await place.lapse();

  assert.match(await place.turn("holder"),
    /\[claim_expired\] claim_\S+ file:src\/x\.mjs - your claim has run out/);
});

test("taking it again clears the report and leaves one claim", async t => {
  const place = await workspace(t);
  await place.attach("holder");
  await place.cli("claim", "--resource", "file:src/x.mjs", "--reason", "editing",
    "--lease", "2");
  await place.lapse();

  await place.cli("claim", "--resource", "file:src/x.mjs", "--reason", "editing");

  // An item nobody can answer is the defect this project keeps finding, so the
  // way out has to work. Looking for the session's own claim only among the live
  // ones left the lapsed record beside the new one, and the report stood.
  const shown = await place.turn("holder");
  assert.equal(shown.includes("claim_expired"), false, shown);
  const session = await place.sessionOf("holder");
  const { snapshot } = JSON.parse((await place.cli("sync", "--session", session,
    "--scope", "full")).stdout).data;
  assert.equal(snapshot.claims.length, 1);
});

test("releasing it clears the report too", async t => {
  const place = await workspace(t);
  await place.attach("holder");
  const { stdout } = await place.cli("claim", "--resource", "file:src/x.mjs",
    "--reason", "editing", "--lease", "2");
  const { claimId } = JSON.parse(stdout).data;
  await place.lapse();

  await place.cli("release", "--claim", claimId);

  // Two ways out, because an owner who no longer wants the file should not have
  // to take it back to stop being told about it.
  assert.equal((await place.turn("holder")).includes("claim_expired"), false);
});

test("a peer is not told about somebody else's lapsed claim", async t => {
  const place = await workspace(t);
  await place.attach("holder");
  const holder = await place.sessionOf("holder");
  await place.cli("claim", "--session", holder, "--resource", "file:src/x.mjs",
    "--reason", "editing", "--lease", "2");
  await place.attach("peer");
  await place.lapse();

  // It is news to its owner and nobody else's business: for a peer the file is
  // simply free again, which the roster and the guard already say.
  assert.equal((await place.turn("peer")).includes("claim_expired"), false);
});
