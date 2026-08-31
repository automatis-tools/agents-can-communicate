import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * A turn that reports something the reader cannot reach.
 *
 * The whole point of the injected turn is that an agent acts on it without being
 * asked twice. Two things in it could not be acted on. `[direct_request] The
 * physics review` named no message, and `acc ack` takes one - so an agent told
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
  await run("mkdir", ["-p", root]);
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  if (budgetBytes !== undefined) {
    await writeFile(path.join(root, "acc.workspace.json"), `${JSON.stringify({
      schemaVersion: 1, workspaceId: "workspace_turn_budget", displayName: "turn",
      roots: ["."], policy: { claimMode: "advisory", contextBudgetBytes: budgetBytes },
      requiredAdapters: [],
    }, null, 2)}\n`);
  }
  for (const [participant, harness] of [["sender", "codex"], ["reader", "claude_code"]]) {
    const child = run(process.execPath, [hook, harness],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: participant, cwd: root, source: "startup" }));
    await child;
  }
  const cli = (args, who) => run(process.execPath, [acc, ...args, "--cwd", root],
    { env: { ...env, CLAUDE_CODE_SESSION_ID: who } });
  const turn = async () => {
    const child = run(process.execPath, [hook, "claude_code"],
      { env: { ...env, ACC_PARTICIPANT: "reader" } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit",
      session_id: "reader", cwd: root, prompt: "go" }));
    const { stdout } = await child;
    if (stdout.trim() === "") return "";
    return JSON.parse(stdout).hookSpecificOutput.additionalContext;
  };
  return { root, env, cli, turn };
}

test("a message addressed to you arrives with the id that answers it", async t => {
  const place = await workspace(t, {});
  await place.cli(["message", "--to", "reader", "--subject", "The physics review",
    "--body", "Which way should the hull clamp?", "--requires-ack"], "sender");

  const shown = await place.turn();

  const [, messageId] = /\[direct_request\] (message_\S+)/.exec(shown) ?? [];
  assert.equal(typeof messageId, "string",
    `the reader cannot name what was addressed to it:\n${shown}`);
  // The id is worth showing only if it is the one the command takes.
  const { stdout } = await place.cli(["ack", "--message", messageId], "reader");
  assert.match(stdout, /acknowledged/);
});

test("what the budget withheld comes with the way to read it", async t => {
  const place = await workspace(t, { budgetBytes: 200 });
  await place.cli(["message", "--to", "reader", "--subject", "The physics review",
    "--body", "Here is a long explanation of the sinking tank. ".repeat(8)], "sender");

  const shown = await place.turn();

  assert.match(shown, /message\(s\) addressed to you did not fit/);
  assert.match(shown, /acc sync --scope full --json/,
    `something was withheld and nothing said how to see it:\n${shown}`);
});

test("the note always fits, however tight the budget", async t => {
  const place = await workspace(t, { budgetBytes: 200 });
  for (let index = 0; index < 6; index += 1) {
    await place.cli(["message", "--to", "reader", "--subject", `Note ${index}`,
      "--body", "x".repeat(400)], "sender");
  }

  const shown = await place.turn();

  // The reserve exists so the projection never runs out of room to say that it
  // ran out of room - including room for the command that recovers what it lost.
  assert.match(shown, /acc sync --scope full --json/);
});

test("what the turn withheld is still there to be read", async t => {
  const place = await workspace(t, { budgetBytes: 200 });
  await place.cli(["message", "--to", "reader", "--subject", "The physics review",
    "--body", "Here is a long explanation of the sinking tank. ".repeat(8)], "sender");
  await place.turn();

  // Withheld, not delivered: a receipt that advanced here would tell the sender
  // it landed when the reader never saw a word of it.
  const { stdout } = await place.cli(["sync", "--scope", "full", "--json"], "reader");
  const payload = JSON.parse(stdout).data;
  const subjects = payload.snapshot.messages.map(item => item.subject);
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
  assert.equal(skills.length, 4);
  for (const { file, text } of skills) {
    assert.match(text, /\[direct_request\] message_x/, `${file} does not say what to do`);
    assert.match(text, /not shown, over budget/, `${file} never mentions the budget line`);
    assert.match(text, /sync --scope full --json/, `${file} does not say how to read them`);
  }
});
