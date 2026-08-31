import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * A message a model is never shown is not a message.
 *
 * The projector could always fence and attribute a peer message, and the
 * delivery state machine could always move `queued -> injected`. Neither ever
 * ran: `sync` returned no messages, so the runner handed the projector an empty
 * list on every turn. A recipient saw the subject through its attention line
 * and nothing else, and no receipt in production ever left `queued`.
 *
 * Driven through the real binaries, because the gap was exactly between two
 * pieces that each worked on their own.
 */
async function place(t, policy = null) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-delivery-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  if (policy !== null) {
    await writeFile(path.join(project, "acc.workspace.json"), `${JSON.stringify({
      schemaVersion: 1, workspaceId: "workspace_deliverytest", displayName: "delivery",
      roots: ["."], policy }, null, 2)}\n`);
  }
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };

  const start = async (adapter, clientSessionId) => {
    const child = run(process.execPath, [hook, adapter, "sessionStart"],
      { env: { ...env, ACC_PARTICIPANT: adapter } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: clientSessionId, cwd: project, source: "startup" }));
    await child;
  };
  await start("codex", "reader-1");
  await start("claude_code", "sender-1");

  const { stdout } = await run(process.execPath,
    [acc, "doctor", "--cwd", project, "--json"], { env });
  const runtimeDir = JSON.parse(stdout).data.runtimeRoot;
  const reader = await loadSessionBinding({ runtimeDir, harnessSessionId: "reader-1" });
  const sender = await loadSessionBinding({ runtimeDir, harnessSessionId: "sender-1" });
  return { project, env, reader, sender };
}

/**
 * The text a client would hand its model at the next turn.
 *
 * Injection contracts do not agree even in modality: Claude Code wants a
 * `hookSpecificOutput` envelope, and Codex takes a hook's stdout verbatim as a
 * `developer` message. Unwrapped here so the assertions can be about the
 * content rather than about whose envelope it arrived in.
 */
async function turn({ project, env }, adapter, clientSessionId) {
  const child = run(process.execPath, [hook, adapter, "userPromptSubmit"],
    { env: { ...env, ACC_PARTICIPANT: adapter } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit",
    session_id: clientSessionId, cwd: project, prompt: "carry on" }));
  const { stdout } = await child;
  if (stdout.trim() === "") return "";
  if (!stdout.trimStart().startsWith("{")) return stdout;
  return JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
}

const send = ({ project, env, sender }, extra = []) => run(process.execPath,
  [acc, "message", "--session", sender.accSessionId, "--generation", sender.generation,
    "--cwd", project, "--to", "codex", "--type", "question", "--subject", "src/store",
    "--body", "Need 20 minutes in src/store. Can you release it?", ...extra],
  { env }).then(({ stdout }) => stdout.trim().replace(/^sent /, ""));

/** Receipt states, read the way an agent would read them. */
async function receipts({ project, env, reader }) {
  const { stdout } = await run(process.execPath, [acc, "sync", "--session",
    reader.accSessionId, "--scope", "full", "--cwd", project, "--json"], { env });
  return JSON.parse(stdout).data.snapshot.receipts;
}

test("a peer's message body reaches the recipient's turn, fenced and attributed", async t => {
  const where = await place(t);
  const messageId = await send(where);

  const context = await turn(where, "codex", "reader-1");

  assert.match(context, new RegExp(`id ${messageId}`),
    "the body never reached the model - only the attention line did");
  assert.match(context, /Need 20 minutes in src\/store/);
  assert.match(context, /untrusted peer message/);
  // The block has to close, or everything after it reads as ACC's own words.
  const fences = context.split("\n").filter(line => line.startsWith("```")).length;
  assert.equal(fences % 2, 0, `unbalanced fences:\n${context}`);
});

test("delivery is recorded as injected once the model has been shown it", async t => {
  const where = await place(t);
  const messageId = await send(where);

  assert.deepEqual((await receipts(where)).map(r => r.state), ["queued"]);
  await turn(where, "codex", "reader-1");

  const after = await receipts(where);
  assert.equal(after.length, 1);
  assert.equal(after[0].messageId, messageId);
  assert.equal(after[0].state, "injected",
    "the receipt never left queued, so the sender is told nothing landed");
});

test("the body is shown once, then a one-shot breadcrumb, then silence", async t => {
  const where = await place(t);
  const messageId = await send(where);

  const first = await turn(where, "codex", "reader-1");
  const second = await turn(where, "codex", "reader-1");
  const third = await turn(where, "codex", "reader-1");

  // Turn one: the full fenced body.
  assert.match(first, new RegExp(messageId));
  assert.equal(first.includes("Need 20 minutes in src/store"), true);

  // Turn two: the body is not replayed - a fenced block cut across turns is the
  // failure the whole-or-nothing rule exists to prevent - but the message
  // carries no ack obligation, so it leaves a single low-priority breadcrumb
  // naming its id, the recovery path an agent can act on.
  assert.equal(second.includes("Need 20 minutes in src/store"), false,
    "the full body was replayed, not just the breadcrumb");
  assert.match(second, /unread_note/);
  assert.equal(second.includes(messageId), true,
    "the breadcrumb does not name the message, so it cannot be recovered");

  // Turn three and after: silent. The receipt is `seen`, so the breadcrumb does
  // not nag past its single turn - a delivered note is recoverable, not a drip.
  assert.equal(third.includes(messageId), false,
    "the breadcrumb nagged past its one turn");
});

test("a sender is not shown its own message", async t => {
  const where = await place(t);
  await send(where);

  // Addressed to `codex`; the sender is `claude_code`. Getting it back would be
  // a session talking to itself through the coordination layer.
  const context = await turn(where, "claude_code", "sender-1");

  assert.equal(context.includes("untrusted peer message"), false, context);
});

test("a message the budget could not fit stays queued rather than reported delivered", async t => {
  // The project sets its own ceiling. `policy.contextBudgetBytes` was validated
  // and documented from the start and never read by anything - the projector was
  // always called with its own default - so this asserts the knob works as well
  // as what happens at the edge of it.
  const where = await place(t, { contextBudgetBytes: 200 });
  await run(process.execPath, [acc, "message", "--session", where.sender.accSessionId,
    "--generation", where.sender.generation, "--cwd", where.project, "--to", "codex",
    "--type", "note", "--subject", "log", "--body", "x".repeat(3_000)], { env: where.env });

  const context = await turn(where, "codex", "reader-1");

  assert.equal(context.includes("xxxxxxxx"), false, "an oversized body was injected anyway");
  assert.equal(Buffer.byteLength(context, "utf8") <= 200, true,
    `the configured ceiling was ignored: ${Buffer.byteLength(context, "utf8")} bytes`);
  // Said out loud, with the one narrow command that retrieves exactly it.
  assert.match(context, /acc inbox --message message_/);
  assert.deepEqual((await receipts(where)).map(receipt => receipt.state), ["queued"],
    "the receipt says injected for text the model never saw - the sender is misinformed");
});

test("a lone session is still shown what was already said to it", async t => {
  // The exact hole: "solo costs nothing" ran before the inbox was read, so a
  // message waiting for you vanished the moment you became the only session.
  // A note needing no acknowledgement raises no attention item, so nothing else
  // keeps the projection alive - this is the case where the rule bites.
  const where = await place(t);
  await run(process.execPath, [acc, "message", "--session", where.sender.accSessionId,
    "--generation", where.sender.generation, "--cwd", where.project, "--to", "codex",
    "--type", "note", "--subject", "handover", "--body", "Left the parser half-done."],
  { env: where.env });

  // The sender leaves. The reader is now alone, with mail.
  const child = run(process.execPath, [hook, "claude_code", "sessionEnd"], { env: where.env });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd",
    session_id: "sender-1", cwd: where.project, reason: "exit" }));
  await child;

  const shown = await turn(where, "codex", "reader-1");

  assert.match(shown, /Left the parser half-done\./,
    "being the only session left swallowed a message already addressed to it");
});

test("a note that reads like a question is nudged toward an answerable form", async t => {
  const where = await place(t);
  const message = (type, subject, body) => run(process.execPath,
    [acc, "message", "--session", where.sender.accSessionId,
      "--generation", where.sender.generation, "--cwd", where.project,
      "--to", "codex", "--type", type, "--subject", subject, "--body", body, "--json"],
    { env: where.env }).then(({ stdout }) => JSON.parse(stdout).data);

  const consequential = await message("note", "Snow", "It touches your file. Have you started?");
  assert.match(consequential.advice ?? "", /--requires-ack|acc decide/,
    "a note asking a question was sent with no nudge to make it answerable");

  const fyi = await message("note", "FYI", "Logged it. Nothing for you to do.");
  assert.equal(fyi.advice, undefined,
    "a plain FYI was nudged, which trains the reader to ignore the nudge");
});
