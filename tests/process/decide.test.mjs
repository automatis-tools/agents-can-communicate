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
 * What was settled, so the next session does not reopen it.
 *
 * `Decision` has been a first-class object in the protocol reference from the
 * start, with an interface, a supersedes chain, and a rule about authority.
 * `recordDecision` implemented all of it and had no command and no tool, so
 * nothing could make one - the register of surfaces called it "no decision
 * surface yet, tracked, not forgotten", and it was the last entry left with that
 * wording.
 *
 * Reading them already worked: they are in a full snapshot. Only writing was
 * missing.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-decide-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const child = run(process.execPath, [hook, "codex"],
    { env: { ...env, ACC_PARTICIPANT: "graphics" } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
    session_id: "graphics", cwd: project, source: "startup" }));
  await child;
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project, "--json"],
    { env });
  const decisions = async () => {
    const session = JSON.parse((await cli("status")).stdout).data.participants[0].sessionId;
    return JSON.parse((await cli("sync", "--session", session, "--scope", "full")).stdout)
      .data.snapshot.decisions;
  };
  return { project, env, cli, decisions };
}

const failed = promise => promise.then(() => null, error => error);

test("an agreement between agents can be written down", async t => {
  const place = await workspace(t);

  const { stdout } = await place.cli("decide", "--title", "hull clamps at half height",
    "--outcome", "settle() clamps to GROUND_Y + height/2");

  assert.equal(JSON.parse(stdout).data.authority, "workstream");
  const [decision] = await place.decisions();
  assert.equal(decision.title, "hull clamps at half height");
  // Written down is only useful if a later session can read it back.
  assert.equal(decision.outcome, "settle() clamps to GROUND_Y + height/2");
});

test("an agent cannot record that a person decided something", async t => {
  const place = await workspace(t);

  const refused = await failed(place.cli("decide", "--title", "ship it",
    "--outcome", "release on friday", "--authority", "human"));

  // The one way this record could do harm: laundering an agent's opinion into a
  // ruling nobody made. Saying `--human` is the caller stating a person did.
  assert.notEqual(refused, null, "an agent recorded a human decision by itself");
  assert.match(JSON.parse(refused.stdout).error.message, /requires an explicit human/);
  assert.deepEqual(await place.decisions(), []);
});

test("with the confirmation, human authority is recorded as such", async t => {
  const place = await workspace(t);

  await place.cli("decide", "--title", "ship it", "--outcome", "release on friday",
    "--authority", "human", "--human");

  const [decision] = await place.decisions();
  assert.equal(decision.authority, "human");
});

test("superseding a decision that does not exist is refused", async t => {
  const place = await workspace(t);

  const refused = await failed(place.cli("decide", "--title", "revised",
    "--outcome", "the other way", "--supersedes", "decision_nope"));

  // A supersedes chain that points at nothing is worse than no chain: it reads
  // as history that was checked.
  assert.notEqual(refused, null);
  assert.match(JSON.parse(refused.stdout).error.message, /superseded decision does not exist/);
});

test("a decision replaces the one it names", async t => {
  const place = await workspace(t);
  const first = JSON.parse((await place.cli("decide", "--title", "clamp at full height",
    "--outcome", "no clamping")).stdout).data.decisionId;

  await place.cli("decide", "--title", "hull clamps at half height",
    "--outcome", "settle() clamps to GROUND_Y + height/2", "--supersedes", first);

  const superseded = (await place.decisions()).find(item => item.supersedes !== null);
  assert.equal(superseded.supersedes, first);
});
