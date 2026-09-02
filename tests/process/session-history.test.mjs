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
 * A closed session is never removed, and that is on purpose.
 *
 * Two things depend on the record outliving the session: a message is
 * attributed to whoever sent it, and the roster is where "which worktree was
 * that agent in" is answered - the question a session cannot answer itself,
 * because the agents worth asking about are the ones that are not running.
 *
 * The cost was legibility. After twenty sessions had come and gone, `acc status`
 * listed twenty-one participants for one live one, and every reader had to work
 * out which of them were actually there.
 *
 * Attribution no longer needs the lookup: a message carries the participant that
 * sent it. That is what would have to be true before a closed session could ever
 * be retired, and it is true now - the retention itself is a decision about how
 * much history a project wants to keep, which is not this code's to make.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-history-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const event = async (participant, payload) => {
    const child = run(process.execPath, [hook, "codex"],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ cwd: project, ...payload }));
    const { stdout } = await child;
    return stdout;
  };
  const attach = (participant, session) => event(participant,
    { hook_event_name: "SessionStart", session_id: session, source: "startup" });
  const close = (participant, session) => event(participant,
    { hook_event_name: "SessionEnd", session_id: session, reason: "exit" });
  const turn = async (participant, session) => {
    const stdout = await event(participant,
      { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "go" });
    // Adapters do not agree on the shape: three answer with JSON on stdout and
    // this one writes the text straight out.
    if (stdout.trim() === "" || !stdout.trimStart().startsWith("{")) return stdout;
    return JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? stdout;
  };
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project], { env });
  const roster = async (...argv) => JSON.parse((await cli("status", ...argv, "--json"))
    .stdout).data.participants;
  return { project, env, attach, close, turn, cli, roster };
}

test("status shows who is here, not everyone who ever was", async t => {
  const place = await workspace(t);
  await place.attach("keeper", "keeper");
  const [keeper] = await place.roster();
  await place.cli("claim", "--session", keeper.sessionId, "--resource", "file:x",
    "--reason", "editing");
  for (let index = 0; index < 8; index += 1) {
    await place.attach(`agent${index}`, `s${index}`);
    await place.close(`agent${index}`, `s${index}`);
  }

  const here = await place.roster();

  assert.deepEqual(here.map(item => item.participantId), ["keeper"],
    "a reader has to work out which of these are actually present");
});

test("the history is still there for whoever needs it", async t => {
  const place = await workspace(t);
  await place.attach("keeper", "keeper");
  const [keeper] = await place.roster();
  await place.cli("claim", "--session", keeper.sessionId, "--resource", "file:x",
    "--reason", "editing");
  await place.attach("departed", "gone");
  await place.close("departed", "gone");

  const everyone = await place.roster("--all");

  // "Which worktree was that agent in" cannot be asked of the agent: the ones
  // worth asking about are the ones that are not running.
  const departed = everyone.find(item => item.participantId === "departed");
  assert.notEqual(departed, undefined, "the record a cleanup needs is gone");
  assert.equal(departed.presence, "offline");
  assert.equal(typeof departed.checkoutRoot, "string");
});

test("a message says who sent it, not only which session did", async t => {
  const place = await workspace(t);
  await place.attach("asker", "asker-1");
  await place.attach("helper", "helper-1");
  const roster = await place.roster();
  const asker = roster.find(item => item.participantId === "asker");
  await place.cli("message", "--session", asker.sessionId, "--to", "helper",
    "--subject", "which way should the hull clamp?", "--body", "Blocking me.",
    "--type", "question");

  const { stdout } = await place.cli("sync", "--session", asker.sessionId,
    "--scope", "full", "--json");
  const [message] = JSON.parse(stdout).data.snapshot.messages;

  assert.equal(message.fromParticipantId, "asker");
});

test("a stalled question survives the session that asked it", async t => {
  const place = await workspace(t);
  await place.attach("asker", "asker-1");
  await place.attach("helper", "helper-1");
  const roster = await place.roster();
  const asker = roster.find(item => item.participantId === "asker");
  await place.cli("message", "--session", asker.sessionId, "--to", "helper",
    "--subject", "which way should the hull clamp?", "--body", "Blocking me.",
    "--type", "question");
  await place.close("helper", "helper-1");
  await place.close("asker", "asker-1");

  // The asker comes back as a new session. Resolving the sender through its old
  // session record worked only for as long as that record was kept, which is
  // exactly what made the record impossible to retire.
  await place.attach("asker", "asker-2");
  const shown = await place.turn("asker", "asker-2");

  assert.match(shown, /\[recipient_unavailable\] message_\S+ which way should the hull clamp\?/,
    `a restarted asker lost track of its own question:\n${shown}`);
});
