import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { COMMANDS } from "@agents-can-communicate/cli";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * An agent has to be able to say who it is.
 *
 * Every mutating command acts as a session and proves it with that session's
 * generation. Both used to be required on the command line, and the shipped
 * skills told agents to pass `--session "$ACC_SESSION" --generation
 * "$ACC_GENERATION"` — two variables nothing in this system has ever set. The
 * generation is deliberately absent from `acc status` as well, being proof of
 * ownership rather than public information.
 *
 * So the whole documented workflow was unreachable: on all four native clients,
 * `work`, `claim`, `message`, `request`, `task`, `ack` and `finish` could not be
 * run by the agent they were written for. Only the MCP path worked, because that
 * server resolves its own session and never asks the model for one.
 *
 * These tests drive the real CLI through the real hook runtime, and pass no
 * identifiers at all — the way the skill now tells an agent to.
 */
async function stage(t, { participants }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-resolve-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const env = { ...process.env, ACC_DATA_HOME: path.join(root, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  await run("git", ["init", "-q", "-b", "main", project], { env, cwd: root })
    .catch(async () => { await run("mkdir", ["-p", project]); });

  for (const { participant, harness, session } of participants) {
    const child = run("node", [hook, harness],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: session, cwd: project, source: "startup" }));
    await child;
  }
  const cli = (args, extra = {}) => run("node", [acc, ...args],
    { cwd: project, env: { ...env, ...extra } });
  return { project, env, cli };
}

test("an agent that was told no identifiers can still publish intent", async t => {
  const { cli } = await stage(t,
    { participants: [{ participant: "solo", harness: "codex", session: "h-1" }] });

  // Exactly what the skill now says to run. Nothing here names a session.
  const { stdout } = await cli(["work", "--summary", "porting the claim model"]);

  assert.match(stdout, /intent: porting the claim model/);
});

test("the whole request loop runs with no identifiers on either side", async t => {
  const { cli } = await stage(t, { participants: [
    { participant: "graphics", harness: "claude_code", session: "gfx" },
    { participant: "physics", harness: "codex", session: "phy" }] });

  // Two live sessions in one checkout, so neither is resolvable by elimination.
  // Each is recognised by the session id its own client exports.
  await cli(["request", "--to", "physics", "--title", "Tank sinks through mud",
    "--detail", "settle() adds mudDepth with nothing stopping it."],
  { CLAUDE_CODE_SESSION_ID: "gfx" });

  const { stdout: waiting } = await cli(["status", "--json"],
    { CLAUDE_CODE_SESSION_ID: "phy" });
  const attention = JSON.parse(waiting).data.attention;
  const taskId = attention.find(item => item.kind === "task_unblocked")?.sourceId;
  assert.equal(typeof taskId, "string",
    `physics was not told work is waiting: ${JSON.stringify(attention)}`);

  const { stdout: taken } = await cli(["task", "--task", taskId, "--take"],
    { CLAUDE_CODE_SESSION_ID: "phy" });
  assert.match(taken, /in_progress/);
  const { stdout: done } = await cli(["task", "--task", taskId, "--state", "done"],
    { CLAUDE_CODE_SESSION_ID: "phy" });
  assert.match(done, /done/);
});

test("a session id from status is enough; the generation is looked up", async t => {
  const { cli } = await stage(t,
    { participants: [{ participant: "solo", harness: "codex", session: "h-1" }] });
  const { stdout } = await cli(["status", "--json"]);
  const { sessionId } = JSON.parse(stdout).data.participants[0];

  // The half an agent can discover is the half it may use. Refusing this would
  // teach that both halves are public, or that neither is usable.
  const { stdout: intent } = await cli(["work", "--session", sessionId,
    "--summary", "reading the store"]);

  assert.match(intent, /intent: reading the store/);
});

test("two live sessions it cannot tell apart stop it rather than guessing", async t => {
  const { cli } = await stage(t, { participants: [
    { participant: "graphics", harness: "claude_code", session: "gfx" },
    { participant: "physics", harness: "codex", session: "phy" }] });

  // Same checkout, nothing in the environment. Picking one would let an agent
  // act as another - the single thing the generation exists to prevent.
  const failure = await cli(["work", "--summary", "whose intent is this"])
    .then(() => null, error => error);

  assert.notEqual(failure, null, "it guessed instead of refusing");
  assert.match(failure.stderr, /could not tell which of 2 live sessions/);
  assert.match(failure.stderr, /graphics \(claude_code\)|physics \(codex\)/);
});

test("a session that has closed is not mistaken for the caller", async t => {
  const { project, env, cli } = await stage(t, { participants: [
    { participant: "gone", harness: "codex", session: "old" },
    { participant: "here", harness: "claude_code", session: "new" }] });

  const child = run("node", [hook, "codex"], { env: { ...env, ACC_PARTICIPANT: "gone" } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd",
    session_id: "old", cwd: project, reason: "exit" }));
  await child;

  // One live session left, so elimination is unambiguous again. A stale binding
  // that still counted would make this ambiguous forever.
  const { stdout } = await cli(["work", "--summary", "carrying on alone"]);

  assert.match(stdout, /intent: carrying on alone/);
});

/**
 * The gate for the class, not for the instance.
 *
 * `surface-coverage.test.mjs` asks whether a core operation can be called at
 * all. It passed throughout, because every one of these commands existed and was
 * routed. What could not be supplied was the *arguments*: an operation whose
 * required argument an agent has no way to obtain is as unreachable as one with
 * no command. This runs each agent-facing command the way the skill tells an
 * agent to, and fails if any of them refuses for want of identity.
 */
// Arguments for the ones that need them; every other command in the CLI is
// covered by the derivation below rather than by being remembered here.
const AGENT_FACING = Object.freeze([
  ["sync", []],
  ["status", []],
  ["work", ["--summary", "a line of intent"]],
  ["claim", ["--resource", "file:src/**", "--reason", "editing"]],
  ["message", ["--to", "peer", "--subject", "s", "--body", "b"]],
  ["request", ["--to", "peer", "--title", "please take this"]],
  ["task", ["--title", "something to do"]],
  ["workstream", ["--title", "a stream", "--objective", "an objective"]],
  ["ack", ["--message", "message_absent"]],
  ["finish", ["--goal", "what this session was for"]],
  ["decide", ["--title", "settled", "--outcome", "what was settled"]],
  ["release", ["--claim", "claim_absent"]],
]);

// Setup and lifecycle: a model should not be running the installer, and these
// three are the adapter's own calls, which pass their identity explicitly.
const NOT_AGENT_FACING = Object.freeze(["install", "uninstall", "doctor", "config",
  "attach", "heartbeat", "detach",
  // These answer about the program itself, so they need no session and must
  // work in a directory that is no workspace.
  "help", "version", "update"]);

test("the list above is every command an agent can run", async () => {
  // Remembered lists rot. `acc decide` was added, needed an identity like the
  // rest, and was not in this list - so the gate for exactly that defect passed
  // while the command refused every agent that tried it.
  const covered = new Set([...AGENT_FACING.map(([command]) => command),
    ...NOT_AGENT_FACING]);
  const forgotten = Object.keys(COMMANDS).filter(command => !covered.has(command));

  assert.deepEqual(forgotten, [],
    "a command exists that this gate does not exercise");
});

test("no agent-facing command refuses for want of an identity", async t => {
  const { cli } = await stage(t,
    { participants: [{ participant: "solo", harness: "codex", session: "h-1" }] });

  const refused = [];
  for (const [command, args] of AGENT_FACING) {
    const error = await cli([command, ...args]).then(() => null, failure => failure);
    // Some of these legitimately fail on their own subject - `ack` names a
    // message that does not exist. What none of them may do is fail because the
    // caller could not say who it is.
    if (error !== null && /--session|--generation|could not tell which session/
      .test(error.stderr)) refused.push(`${command}: ${error.stderr.trim()}`);
  }

  assert.deepEqual(refused, [],
    "these ask the agent for something the agent has no way to obtain");
});

test("no shipped skill or document teaches a variable nothing sets", async () => {
  // The general form of the defect: instructions an agent cannot follow read
  // exactly like instructions it can. `$ACC_SESSION` survived four rewrites of
  // the skill and three of the docs, because nothing ever ran what they said.
  const sources = [];
  for (const root of ["packages", "docs"]) {
    const entries = await readdir(path.join(repo, root),
      { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if (file.includes("node_modules")) continue;
      sources.push({ file, text: await readFile(file, "utf8") });
    }
  }
  sources.push({ file: path.join(repo, "README.md"),
    text: await readFile(path.join(repo, "README.md"), "utf8") });

  // Every ACC_* variable the code actually reads. Anything else in a code block
  // is a promise the runtime does not keep.
  const provided = new Set(["ACC_DATA_HOME", "ACC_PARTICIPANT", "ACC_SESSION",
    "ACC_GENERATION"]);
  const taught = new Map();
  for (const { file, text } of sources) {
    for (const [, name] of text.matchAll(/\$\{?(ACC_[A-Z_]+)\}?/g)) {
      if (!provided.has(name)) (taught.get(name) ?? taught.set(name, []).get(name)).push(file);
    }
  }
  assert.deepEqual([...taught.keys()], [],
    "documentation tells an agent to use a variable nothing exports");

  // ACC_SESSION and ACC_GENERATION are read by the resolver as an escape hatch,
  // but nothing sets them, so no instruction may depend on one.
  for (const { file, text } of sources) {
    assert.equal(text.includes("$ACC_SESSION"), false,
      `${file} still tells an agent to pass a session id it has no way to obtain`);
  }
});
