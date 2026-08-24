import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");

/**
 * Addressing a peer nobody has ever been.
 *
 * `acc message --to physcis` answered "sent". The message went nowhere, the
 * agent that meant `physics` had no way to find out, and the receipt sat in the
 * store forever addressed to somebody who does not exist. `acc request` was
 * worse: it made a task assigned to nobody, and the requester waited for an
 * agent that was never coming.
 *
 * A mistyped name is the most ordinary mistake an agent can make here, and it is
 * the one the tool was quietest about.
 *
 * Unbounded, too. One message naming three thousand participants took 24.8
 * seconds and wrote three thousand receipts, after which attaching and taking a
 * single turn in that workspace cost 5.1 seconds - past the point where a hook
 * gives up and allows whatever it was guarding. Nothing bounded the list, and
 * nothing needs to now: a recipient has to be somebody, and a workspace has as
 * many participants as it has agents.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-stranger-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project, "--json"],
    { env });
  const attach = async participant => JSON.parse((await cli("attach",
    "--participant", participant, "--harness", "cli")).stdout).data;
  return { base, project, env, cli, attach };
}

const failed = promise => promise.then(() => null, error => error);

test("a message to a name nobody has is refused, and says who is here", async t => {
  const place = await workspace(t);
  const sender = await place.attach("graphics");
  await place.attach("physics");

  const refused = await failed(place.cli("message", "--session", sender.sessionId,
    "--generation", sender.generation, "--to", "physcis",
    "--subject", "typo", "--body", "did this go anywhere?"));

  assert.notEqual(refused, null, "a message to nobody was reported as sent");
  assert.equal(refused.code, EXIT.DATA);
  const { error } = JSON.parse(refused.stdout);
  assert.match(error.message, /no participant here is called physcis/);
  // Naming who is here is what turns the refusal into a correction.
  assert.match(error.message, /graphics, physics/);
});

test("a request to a name nobody has makes no task", async t => {
  const place = await workspace(t);
  const sender = await place.attach("graphics");
  await place.attach("physics");

  const refused = await failed(place.cli("request", "--session", sender.sessionId,
    "--generation", sender.generation, "--to", "physcis", "--title", "typo"));

  assert.notEqual(refused, null, "work was addressed to nobody");
  const { snapshot } = JSON.parse((await place.cli("sync", "--session", sender.sessionId,
    "--scope", "full")).stdout).data;
  assert.deepEqual(snapshot.tasks, [],
    "a task was left addressed to an agent that will never come");
});

test("a peer who has gone is still a peer", async t => {
  const place = await workspace(t);
  const sender = await place.attach("graphics");
  const leaving = await place.attach("physics");
  await place.cli("detach", "--session", leaving.sessionId,
    "--generation", leaving.generation);

  // The whole point of addressing work to a participant is that it outlives
  // their session. "Has been here" is the test, not "is here now".
  const { stdout } = await place.cli("request", "--session", sender.sessionId,
    "--generation", sender.generation, "--to", "physics",
    "--title", "Tank sinks through mud");

  assert.equal(JSON.parse(stdout).ok, true);
});

test("a recipient list can only name participants, so it is bounded by them", async t => {
  const place = await workspace(t);
  const sender = await place.attach("graphics");
  await place.attach("physics");

  const strangers = Array.from({ length: 200 }, (_, index) => ["--to", `p${index}`]).flat();
  const refused = await failed(place.cli("message", "--session", sender.sessionId,
    "--generation", sender.generation, ...strangers,
    "--subject", "broadcast", "--body", "hello"));

  assert.notEqual(refused, null, "two hundred receipts were written for nobody");
  const { snapshot } = JSON.parse((await place.cli("sync", "--session", sender.sessionId,
    "--scope", "full")).stdout).data;
  assert.deepEqual(snapshot.receipts, []);
});

test("a body that cannot be stored is refused for that, not for its recipient", async t => {
  const place = await workspace(t);
  const sender = await place.attach("graphics");

  const refused = await failed(place.cli("message", "--session", sender.sessionId,
    "--generation", sender.generation, "--to", "nobody",
    "--subject", "urgent", "--body", `${String.fromCharCode(27)}[2Jcleared`));

  // Both are wrong, and the error nearest the mistake is the useful one - the
  // control character is wrong whoever it was addressed to.
  assert.notEqual(refused, null);
  assert.match(JSON.parse(refused.stdout).error.message, /control characters/i);
});

test("work cannot be assigned to a name nobody has", async t => {
  const place = await workspace(t);
  const sender = await place.attach("graphics");
  await place.attach("physics");

  const refused = await failed(place.cli("task", "--session", sender.sessionId,
    "--generation", sender.generation, "--title", "fix the tank",
    "--assignee", "physcis"));

  // `acc task --assignee` is how work is handed over without a message, and it
  // was the one path this rule had not reached. A task left `pending` for a
  // participant nobody has ever been is invisible to every roster, raises
  // `task_unblocked` for nobody, and is not even stalled - nothing was waiting
  // on it that could be told.
  assert.notEqual(refused, null, "work was assigned to nobody");
  assert.match(JSON.parse(refused.stdout).error.message, /no participant here is called physcis/);
  const { snapshot } = JSON.parse((await place.cli("sync", "--session", sender.sessionId,
    "--scope", "full")).stdout).data;
  assert.deepEqual(snapshot.tasks, []);
});

test("work with no assignee at all is still allowed", async t => {
  const place = await workspace(t);
  const sender = await place.attach("graphics");

  // Unassigned work is ordinary: a task noted now and picked up by whoever
  // takes it. The rule is about naming somebody who is not there, not about
  // naming nobody.
  const { stdout } = await place.cli("task", "--session", sender.sessionId,
    "--generation", sender.generation, "--title", "something to do");

  assert.equal(JSON.parse(stdout).ok, true);
});
