import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";
import { runtimePaths } from "@agents-can-communicate/cli";
import { createCoordinationService } from "@agents-can-communicate/core";
import { createId } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const hook = path.join(repo, "bin", "acc-hook.mjs");
const WORKSPACE = "workspace_turn_budget";

/**
 * A turn that reports something the reader cannot reach.
 *
 * The whole point of the injected turn is that an agent acts on it without being
 * asked twice. Two things in it could not be acted on. `[reply_required] The
 * physics review` named no message, and acknowledgement takes one - so an agent told
 * that something was addressed to it could not answer. And `+1 not shown, over
 * budget` said something had been withheld while nothing anywhere, skills and
 * documentation included, said how to see it.
 *
 * Both are the shape this project keeps finding: an instruction an agent cannot
 * carry out reads exactly like one it can, and the agent improvises. One of them
 * has already written to the store by hand rather than admit it was stuck.
 */
async function workspace(t, { budgetBytes }) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-turn-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const clientBin = path.join(base, "bin");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(clientBin, { recursive: true })]);
  for (const [command, version] of [["codex", "codex-cli 0.147.0"],
    ["claude", "2.1.233 (Claude Code)"]]) {
    const executable = path.join(clientBin, command);
    await writeFile(executable,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(version)});\n`);
    await chmod(executable, 0o755);
  }
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "", PATH: `${clientBin}${path.delimiter}${process.env.PATH}` };
  await writeFile(path.join(root, "acc.workspace.json"), `${JSON.stringify({
    schemaVersion: 1, workspaceId: WORKSPACE, displayName: "turn",
    roots: ["."], policy: { claimMode: "advisory",
      contextBudgetBytes: budgetBytes ?? 6_000 }, requiredAdapters: [],
  }, null, 2)}\n`);
  for (const [participant, harness] of [["sender", "codex"], ["reader", "claude_code"]]) {
    const child = run(process.execPath, [hook, harness],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: participant, cwd: root, source: "startup" }));
    await child;
  }
  const paths = runtimePaths({ dataHome: env.ACC_DATA_HOME, workspaceId: WORKSPACE,
    workspaceRoots: [root] });
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind, randomBytes) };
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids });
  const sender = await loadSessionBinding({ runtimeDir: paths.root,
    harnessSessionId: "sender" });
  const reader = await loadSessionBinding({ runtimeDir: paths.root,
    harnessSessionId: "reader" });
  let sequence = 0;
  const send = ({ subject, body, requiresAck = false }) => service.sendMessage({
    sessionId: sender.accSessionId, generation: sender.generation,
    clientMessageId: `client_turn_${sequence += 1}`, toParticipantIds: ["reader"],
    kind: requiresAck ? "question" : "note",
    obligation: requiresAck ? "reply" : "none", subject, body,
  });
  const turn = async () => {
    const child = run(process.execPath, [hook, "claude_code"],
      { env: { ...env, ACC_PARTICIPANT: "reader" } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit",
      session_id: "reader", cwd: root, prompt: "go" }));
    const { stdout } = await child;
    if (stdout.trim() === "") return "";
    return JSON.parse(stdout).hookSpecificOutput.additionalContext;
  };
  const inbox = messageId => service.readInbox({ sessionId: reader.accSessionId,
    generation: reader.generation, ...(messageId === undefined ? {} : { messageId }) });
  const acknowledge = messageId => service.acknowledgeMessage({
    sessionId: reader.accSessionId, generation: reader.generation, messageId });
  return { root, env, send, turn, inbox, acknowledge };
}

test("a message addressed to you arrives with the id that answers it", async t => {
  const place = await workspace(t, {});
  await place.send({ subject: "The physics review",
    body: "Which way should the hull clamp?", requiresAck: true });

  const shown = await place.turn();

  const [, messageId] = /\[reply_required\] (message_\S+)/.exec(shown) ?? [];
  assert.equal(typeof messageId, "string",
    `the reader cannot name what was addressed to it:\n${shown}`);
  // The id is worth showing only if it is the one the command takes.
  const receipt = await place.acknowledge(messageId);
  assert.equal(receipt.state, "acknowledged");
});

test("what the budget withheld comes with the way to read it", async t => {
  const place = await workspace(t, { budgetBytes: 200 });
  await place.send({ subject: "The physics review",
    body: "Here is a long explanation of the sinking tank. ".repeat(8) });

  const shown = await place.turn();

  const [, messageId] = /acc inbox --message (message_[A-Za-z0-9_-]+)/.exec(shown) ?? [];
  assert.equal(typeof messageId, "string");
  assert.match(shown, /acc inbox --message/,
    `something was withheld and nothing said how to see it:\n${shown}`);
});

test("the note always fits, however tight the budget", async t => {
  const place = await workspace(t, { budgetBytes: 200 });
  for (let index = 0; index < 6; index += 1) {
    await place.send({ subject: `Note ${index}`, body: "x".repeat(400) });
  }

  const shown = await place.turn();

  // The reserve exists so the projection never runs out of room to say that it
  // ran out of room - including room for the command that recovers what it lost.
  assert.match(shown, /acc inbox --message message_/);
});

test("what the turn withheld is still there to be read", async t => {
  const place = await workspace(t, { budgetBytes: 200 });
  await place.send({ subject: "The physics review",
    body: "Here is a long explanation of the sinking tank. ".repeat(8) });
  await place.turn();

  // Withheld, not delivered: a receipt that advanced here would tell the sender
  // it landed when the reader never saw a word of it.
  const payload = await place.inbox();
  const subjects = payload.map(item => item.message.subject);
  assert.deepEqual(subjects, ["The physics review"]);
});

test("every skill teaches the two lines a turn can end with", async () => {
  // The turn's vocabulary is only useful if the reader was taught it, and the
  // skill is the only place an agent reads.
  const skills = [];
  for (const entry of await readdir(path.join(repo, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const bundle of ["plugin", "extension"]) {
      const file = path.join(repo, "packages", entry.name, bundle,
        "skills", "acc", "SKILL.md");
      const text = await readFile(file, "utf8").catch(() => null);
      if (text !== null) skills.push({ file, text });
    }
  }
  assert.equal(skills.length, 5);
  for (const { file, text } of skills) {
    assert.match(text, /\[reply_required\] message_x/, `${file} does not explain replies`);
    assert.match(text, /\[acknowledgement_required\] message_x/,
      `${file} does not explain acknowledgements`);
    assert.match(text, /inbox --message/, `${file} does not say how to read overflow`);
    assert.match(text, /full workspace sync to recover one message/,
      `${file} does not forbid the expensive recovery path`);
    const full = text.split("\n").find(line => line.includes("sync --scope full --json"));
    assert.match(full ?? "", /forensic/,
      `${file} does not reserve full sync for explicit forensics`);
  }
});
