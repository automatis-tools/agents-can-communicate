import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const acc = fileURL => path.join(fileURL, "bin", "acc.mjs");
const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * A workspace that is not a Git repository at all.
 *
 * Git is how ACC identifies a workspace when one is there, which makes "no Git"
 * the case most likely to leak: a probe that fails loudly, a stray `.git`
 * lookup surfacing as an error the user did not ask about, or runtime state
 * dropped into the project because there was no repository root to put it
 * beside.
 */
async function plainDirectory(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-nogit-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-nogit-data-")));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { cwd, dataHome };
}

const call = async ({ cwd, dataHome }, args) => {
  const { stdout, stderr } = await run(process.execPath,
    [acc(repo), ...args, "--cwd", cwd, "--json"],
    // GIT_* variables leak into child processes from any git-driven caller and
    // would point the probe at a repository that is not this one.
    { env: { ...process.env, ACC_DATA_HOME: dataHome, GIT_DIR: "", GIT_WORK_TREE: "" } });
  return { body: JSON.parse(stdout), stderr };
};

test("a plain directory supports the whole coordination cycle", async t => {
  const place = await plainDirectory(t);

  const attached = await call(place, ["attach", "--participant", "solo",
    "--harness", "cli"]);
  assert.equal(attached.body.ok, true);
  const { sessionId, generation } = attached.body.data;
  const owner = ["--session", sessionId, "--generation", generation];

  const intent = await call(place, ["work", ...owner, "--summary",
    "checking the non-git path", "--mode", "explore"]);
  assert.equal(intent.body.ok, true);

  const claimed = await call(place, ["claim", ...owner,
    "--resource", "file:notes.txt", "--reason", "editing notes"]);
  assert.equal(claimed.body.ok, true);

  const messaged = await call(place, ["message", ...owner, "--to", "solo",
    "--subject", "hello", "--body", "a message to nobody in particular"]);
  assert.equal(messaged.body.ok, true);

  const closed = await call(place, ["detach", ...owner]);
  assert.equal(closed.body.ok, true);
});

test("no Git failure is ever shown to the user", async t => {
  const place = await plainDirectory(t);

  const { stderr } = await call(place, ["attach", "--participant", "solo",
    "--harness", "cli"]);

  // The probe runs and finds nothing, which is a normal answer, not an error.
  // A user in a plain directory must never see git's voice.
  assert.equal(stderr, "");
  assert.equal(/fatal:|not a git repository|git:/i.test(stderr), false);
});

test("nothing is written into the project directory", async t => {
  const place = await plainDirectory(t);
  const owner = await call(place, ["attach", "--participant", "solo", "--harness", "cli"]);
  const { sessionId, generation } = owner.body.data;

  await call(place, ["claim", "--session", sessionId, "--generation", generation,
    "--resource", "file:notes.txt", "--reason", "editing"]);

  // Coordination state belongs to the machine, not to the project. A workspace
  // with no repository is exactly where a tool is tempted to drop a dotfile.
  assert.deepEqual(await readdir(place.cwd), [],
    "ACC left state in the user's directory");
});

test("two sessions in the same plain directory find each other", async t => {
  const place = await plainDirectory(t);

  const first = await call(place, ["attach", "--participant", "one", "--harness", "cli"]);
  const second = await call(place, ["attach", "--participant", "two", "--harness", "cli"]);
  const status = await call(place, ["status"]);

  // Identity without Git falls back to the directory itself, so both sessions
  // must land in the same workspace rather than two lookalikes.
  assert.notEqual(first.body.data.sessionId, second.body.data.sessionId);
  assert.equal(status.body.data.participants.length, 2);
  assert.deepEqual(status.body.data.participants.map(p => p.participantId).sort(),
    ["one", "two"]);
});

test("a claim conflict is reported the same way it would be inside a repository", async t => {
  const place = await plainDirectory(t);
  const first = await call(place, ["attach", "--participant", "one", "--harness", "cli"]);
  const second = await call(place, ["attach", "--participant", "two", "--harness", "cli"]);

  await call(place, ["claim", "--session", first.body.data.sessionId,
    "--generation", first.body.data.generation, "--resource", "file:src/**",
    "--reason", "porting"]);

  await assert.rejects(
    call(place, ["claim", "--session", second.body.data.sessionId,
      "--generation", second.body.data.generation, "--resource", "file:src/a.mjs",
      "--reason", "also porting"]),
    error => {
      // Exit 5 is the conflict code, and the failure has to arrive as a JSON
      // envelope because an adapter is the one caller that cannot read prose.
      assert.equal(error.code, 5);
      const failure = JSON.parse(error.stdout);
      assert.equal(failure.ok, false);
      return true;
    });
});
