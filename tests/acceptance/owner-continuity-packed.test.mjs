import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);
const ownerLine = stdout => {
  assert.notEqual(stdout.trim(), "", "SessionStart must restore its owner's CLI arguments");
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  const line = /^ACC CLI \(append\): (.+)$/m.exec(context);
  assert.ok(line, context);
  return line[1];
};
const cli = async (packed, args, cwd = packed.project) => JSON.parse((await run(process.execPath,
  [packed.accBin, ...args, "--json"], { cwd, env: packed.env })).stdout);
const shellCli = async (packed, suffix, cwd) => JSON.parse((await run("/bin/sh",
  ["-c", '"$TEST_NODE" "$TEST_ACC" status --json ' + suffix],
  { cwd, env: { ...packed.env, TEST_NODE: process.execPath, TEST_ACC: packed.accBin } })).stdout).data;

test("the installed turn header keeps its workspace after shell cwd changes", async t => {
  const packed = await createPackedAcc(t);
  // The header is shell input. Spaces, quotes and expansions must remain literal.
  const project = path.join(packed.root, "owner's $(touch injected) workspace");
  await mkdir(project);
  await packed.hook("claude_code", { hook_event_name: "SessionStart",
    session_id: "native-owner", cwd: project }, { ACC_PARTICIPANT: "original" });
  const turn = await packed.hook("claude_code", { hook_event_name: "UserPromptSubmit",
    session_id: "native-owner", cwd: project });
  const status = await shellCli(packed, ownerLine(turn.stdout), packed.project);
  assert.ok(status.participants.some(p => p.participantId === "original"),
    "the original owner's header silently read another, empty workspace");
  await assert.rejects(access(path.join(packed.project, "injected")), { code: "ENOENT" });
});

test("a compact SessionStart restores the same owner without another user prompt", async t => {
  const packed = await createPackedAcc(t);
  const reader = await packed.start({ adapterId: "claude_code", participantId: "reader",
    harnessSessionId: "native-reader" });
  const sender = await packed.acc(["attach", "--participant", "sender"]);
  const request = await packed.acc(["request", "--session", sender.sessionId,
    "--generation", sender.generation, "--to", "reader", "--title", "Still here?"]);
  const compact = await packed.hook("claude_code", { hook_event_name: "SessionStart",
    source: "compact", session_id: "native-reader", cwd: packed.project });
  const suffix = ownerLine(compact.stdout);
  const status = await shellCli(packed, suffix, packed.consumer);
  assert.equal(status.participants.filter(p => p.participantId === "reader").length, 1);
  assert.equal(status.participants.find(p => p.participantId === "reader").sessionId, reader.sessionId);
  const result = JSON.parse((await run("/bin/sh", ["-c",
    '"$TEST_NODE" "$TEST_ACC" inbox --json ' + suffix], { cwd: packed.consumer,
      env: { ...packed.env, TEST_NODE: process.execPath, TEST_ACC: packed.accBin } })).stdout).data;
  assert.equal(result.items[0].message.messageId, request.message.messageId);
  assert.equal((await packed.receipt(sender.sessionId, request.message.messageId, "reader")).state,
    "queued", "restoring identity must not claim peer-message delivery");
});

test("owned status rejects a different workspace instead of reporting an empty room", async t => {
  const packed = await createPackedAcc(t);
  const owner = await packed.acc(["attach", "--participant", "reader"]);
  const result = await cli(packed, ["status", "--session", owner.sessionId,
    "--generation", owner.generation], packed.consumer).catch(error => JSON.parse(error.stdout));
  assert.equal(result.ok, false, "owned status silently dropped the unknown owner");
  assert.equal(result.error.details.reasonCode, "caller_workspace_mismatch");
  assert.match(result.error.message, /--cwd/);
});
