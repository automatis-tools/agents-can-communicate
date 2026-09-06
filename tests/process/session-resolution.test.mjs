import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { COMMANDS } from "@agents-can-communicate/cli";

import { fixtureOwnerEnv } from "../helpers/fixture-owner.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

// Explicit CLI ownership through the real hook runtime. These fixtures do not
// prove native clients supply credentials: their setup owns each hook payload
// and deliberately passes its pair. Caller inference regressions are exercised
// separately by caller-identity-packed and session-owner tests.
async function stage(t, { participants }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-resolve-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const env = { ...process.env, ACC_DATA_HOME: path.join(root, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  delete env.ACC_SESSION;
  delete env.ACC_GENERATION;
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
  return { project, env, cli, owner: nativeId => fixtureOwnerEnv(env.ACC_DATA_HOME, nativeId) };
}

test("an explicitly configured owner publishes intent without repeated CLI flags", async t => {
  const { cli, owner } = await stage(t,
    { participants: [{ participant: "solo", harness: "codex", session: "h-1" }] });

  const { stdout } = await cli(["work", "--summary", "porting the claim model"],
    await owner("h-1"));

  assert.match(stdout, /intent: porting the claim model/);
});

test("the whole request loop preserves explicitly configured owners", async t => {
  const { cli, owner } = await stage(t, { participants: [
    { participant: "graphics", harness: "claude_code", session: "gfx" },
    { participant: "physics", harness: "codex", session: "phy" }] });

  // Two live sessions in one checkout, so neither is resolvable by elimination.
  // Fixture setup supplies each session's own pair.
  await cli(["request", "--to", "physics", "--title", "Tank sinks through mud",
    "--detail", "settle() adds mudDepth with nothing stopping it."],
  await owner("gfx"));

  const { stdout: waiting } = await cli(["inbox", "--json"],
    await owner("phy"));
  const [request] = JSON.parse(waiting).data;
  assert.equal(request.message.subject, "Tank sinks through mud");
  const { stdout: replied } = await cli(["reply", "--message", request.message.messageId,
    "--body", "I will review the settling path."],
    await owner("phy"));
  assert.match(replied, /^recorded message_/);
});

test("a public selector can name the caller's own explicitly configured session", async t => {
  const { cli, owner } = await stage(t,
    { participants: [{ participant: "solo", harness: "codex", session: "h-1" }] });
  const { stdout } = await cli(["status", "--json"]);
  const { sessionId } = JSON.parse(stdout).data.participants[0];

  // The explicit pair establishes ownership; the public selector does not.
  const { stdout: intent } = await cli(["work", "--session", sessionId,
    "--summary", "reading the store"], await owner("h-1"));

  assert.match(intent, /intent: reading the store/);
});

test("two live sessions it cannot tell apart stop it rather than guessing", async t => {
  const { cli, owner } = await stage(t, { participants: [
    { participant: "graphics", harness: "claude_code", session: "gfx" },
    { participant: "physics", harness: "codex", session: "phy" }] });

  // Same checkout, nothing in the environment. Picking one would let an agent
  // act as another - the single thing the generation exists to prevent.
  const failure = await cli(["work", "--summary", "whose intent is this"])
    .then(() => null, error => error);

  assert.notEqual(failure, null, "it guessed instead of refusing");
  assert.match(failure.stderr, /could not tell which session/);
  assert.match(failure.stderr, /own acc attach/);
});

test("a session that has closed is not mistaken for the caller", async t => {
  const { project, env, cli, owner } = await stage(t, { participants: [
    { participant: "gone", harness: "codex", session: "old" },
    { participant: "here", harness: "claude_code", session: "new" }] });

  const child = run("node", [hook, "codex"], { env: { ...env, ACC_PARTICIPANT: "gone" } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd",
    session_id: "old", cwd: project, reason: "exit" }));
  await child;

  const stale = await cli(["work", "--summary", "wrong survivor"],
    { CLIENT_NATIVE_SESSION: "old" }).then(() => null, error => error);
  assert.notEqual(stale, null, "the closed caller adopted the surviving peer");
  const { stdout } = await cli(["work", "--summary", "carrying on alone"],
    await owner("new"));

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
  ["inbox", []],
  ["reply", ["--message", "message_absent", "--body", "answer"]],
  ["request", ["--to", "peer", "--title", "please take this"]],
  ["ack", ["--message", "message_absent"]],
  ["release", ["--claim", "claim_absent"]],
  // Finish closes the resolved session, so it must be the last identity check.
  ["finish", ["--goal", "what this session was for"]],
]);

// Setup and lifecycle: a model should not be running the installer, and these
// three are the adapter's own calls, which pass their identity explicitly.
const NOT_AGENT_FACING = Object.freeze(["install", "uninstall", "doctor", "config",
  "attach", "heartbeat", "detach",
  // These answer about the program itself, so they need no session and must
  // work in a directory that is no workspace.
  "help", "version", "update"]);

test("the list above is every command an agent can run", async () => {
  // Remembered lists rot. Derive the gap from the command table so a newly
  // added operation cannot evade the identity gate.
  const covered = new Set([...AGENT_FACING.map(([command]) => command),
    ...NOT_AGENT_FACING]);
  const forgotten = Object.keys(COMMANDS).filter(command => !covered.has(command));

  assert.deepEqual(forgotten, [],
    "a command exists that this gate does not exercise");
});

test("every agent-facing command accepts the explicitly configured owner", async t => {
  const { cli, owner } = await stage(t,
    { participants: [{ participant: "solo", harness: "codex", session: "h-1" }] });

  const refused = [];
  for (const [command, args] of AGENT_FACING) {
    const error = await cli([command, ...args], await owner("h-1"))
      .then(() => null, failure => failure);
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

/**
 * The `ACC_*` names a piece of code takes out of the environment.
 *
 * Both spellings, and both taken: the pattern has an alternative per spelling,
 * so one capture group is always undefined and reading only the first threw
 * away every bracketed read - a scan that reported nothing wrong because it had
 * looked at half of what it claimed to.
 */
export function readsFromEnvironment(text) {
  const found = new Set();
  for (const [, dotted, bracketed]
    of text.matchAll(/env\??\.(ACC_[A-Z_]+)|env\[["`'](ACC_[A-Z_]+)["`']\]/g)) {
    found.add(dotted ?? bracketed);
  }
  return found;
}

test("the scan reads both ways of asking the environment", () => {
  // Neither spelling is hypothetical: the first is what the code uses today,
  // and the second is what it would use for a computed name tomorrow.
  assert.deepEqual([...readsFromEnvironment(`
    const a = env.ACC_DOTTED;
    const b = process.env?.ACC_OPTIONAL;
    const c = env["ACC_BRACKETED"];
    const d = runtime.env['ACC_SINGLE'];
    const untouched = "ACC_MENTIONED_IN_PROSE";
  `)].sort(), ["ACC_BRACKETED", "ACC_DOTTED", "ACC_OPTIONAL", "ACC_SINGLE"]);
});

test("every variable the code reads from the environment is written down", async () => {
  // The other direction, and the one that bit: `ACC_MCP_WORKSPACE` decides which
  // project an MCP client joins, and appeared in no document at all. Without it
  // the server takes the directory it was launched in, answers `solo` from a
  // workspace nobody else is in, and says nothing - found by configuring one and
  // wondering where everybody was.
  const code = [];
  for (const root of ["packages", "bin"]) {
    const entries = await readdir(path.join(repo, root),
      { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if (file.includes("node_modules") || file.includes(`${path.sep}test${path.sep}`)) continue;
      code.push(await readFile(file, "utf8"));
    }
  }

  // Read *from the environment*, which is what makes a name configuration. The
  // generated hook shim has `ACC_NODE` and `ACC_RUNNER` in it, and those are
  // shell variables of its own that nobody sets.
  const read = new Set(code.flatMap(text => [...readsFromEnvironment(text)]));
  assert.equal(read.size > 5, true, "the scan found almost nothing, so it proves nothing");

  const documentation = (await Promise.all([...await readdir(path.join(repo, "docs"))]
    .filter(name => name.endsWith(".md"))
    .map(name => readFile(path.join(repo, "docs", name), "utf8"))
    .concat([readFile(path.join(repo, "README.md"), "utf8")]))).join("\n");

  const undocumented = [...read].filter(name => !documentation.includes(name)).sort();
  assert.deepEqual(undocumented, [],
    "these change what the product does and are written down nowhere");
});
