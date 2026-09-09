import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

function ownerFlags(result) {
  assert.notEqual(result.stdout, "", "the installed tool hook supplied no owner context");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.hookSpecificOutput.hookEventName, "PreToolUse");
  const context = envelope.hookSpecificOutput.additionalContext;
  const match = /^ACC CLI \(append\): --session (\S+) --generation (\S+)$/.exec(context);
  assert.ok(match, "tool context must contain only the complete owner line");
  assert.equal(envelope.hookSpecificOutput.updatedInput, undefined, "hook rewrote the command");
  return ["--session", match[1], "--generation", match[2]];
}

async function stage(t) {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ grok: "1.0.13" });
  const hook = (sessionId, hookEventName = "pre_tool_use", toolName = "run_terminal_command") =>
    packed.hook("grok", { hookEventName, sessionId, cwd: packed.project, toolName,
      toolInput: { command: "acc status --json # PRIVATE-COMMAND-CANARY" } });
  const start = async native => {
    await hook(native, "session_start");
    await hook(native, "user_prompt_submit"); // Native Grok discards this stdout.
    return ownerFlags(await hook(native));
  };
  return { packed, hook, start };
}

test("two installed Grok hook owners can communicate without adopting another identity", async t => {
  const { packed, hook, start } = await stage(t);
  const first = await start("grok-first");
  const second = await start("grok-second");
  assert.notEqual(first[1], second[1]);
  assert.notEqual(first[3], second[3]);
  // A public status command finishes before Grok receives this context. Only
  // that hook's pair, not status rows, authorizes the subsequent commands.
  const status = await packed.acc(["status"]);
  const recipient = status.participants.find(p => p.sessionId === second[1]);
  assert.ok(recipient);
  const request = await packed.acc(["request", ...first, "--to", recipient.participantId,
    "--title", "Check the same-owner reply", "--detail", "PRIVATE-PEER-BODY"]);
  assert.deepEqual(ownerFlags(await hook("grok-second")), second);
  const beforeRead = await packed.acc(["sync", "--scope", "full"]);
  assert.equal(beforeRead.snapshot.receipts.find(r => r.messageId === request.message.messageId).state,
    "queued", "identity context claimed delivery of a peer message");
  const [received] = await packed.acc(["inbox", ...second, "--message", request.message.messageId]);
  assert.equal(received.receipt.state, "retrieved");
  const reply = await packed.acc(["reply", ...second, "--message", request.message.messageId,
    "--body", "Verified by the original Grok owner"]);
  assert.equal(reply.message.fromSessionId, second[1]);
  assert.equal(reply.receipt.state, "acknowledged");
  const outsider = await packed.accError(["work", "--summary", "borrowed identity"],
    { GROK_SESSION_ID: "grok-first" });
  assert.equal(JSON.parse(outsider.stdout).error.details.reasonCode, "caller_identity_unresolved");
  for (const flags of [first, second]) {
    const done = await packed.acc(["finish", ...flags, "--goal", "native identity verified"]);
    assert.equal(done.message.fromSessionId, flags[1]);
  }
  assert.equal((await packed.acc(["status"])).counts.live, 0);
});

test("tool ownership never registers, revives, or lends a finished session", async t => {
  const { packed, hook, start } = await stage(t);
  assert.equal((await hook("missing")).stdout, "");
  assert.equal((await packed.acc(["status"])).participants.length, 0);
  const original = await start("native-grok");
  assert.equal((await hook("native-grok", "pre_tool_use", "read_file")).stdout, "");
  await packed.acc(["finish", ...original, "--goal", "first incarnation"]);
  assert.equal((await hook("native-grok")).stdout, "", "tool hook lent a closed owner");
  assert.equal((await packed.acc(["status"])).counts.live, 0);
  await hook("native-grok", "user_prompt_submit");
  const fresh = ownerFlags(await hook("native-grok"));
  assert.notDeepEqual(fresh, original);
  const failed = await packed.accError(["work", ...original, "--summary", "stale owner"]);
  assert.notEqual(failed, null);
  assert.equal((await packed.acc(["work", ...fresh, "--summary", "fresh owner"])).sessionId, fresh[1]);
  await hook("native-grok", "session_end");
  assert.equal((await hook("native-grok")).stdout, "");
});

test("Grok tool context respects the complete owner line's byte budget", async t => {
  const { packed, hook, start } = await stage(t);
  const configFile = path.join(packed.project, "acc.workspace.json");
  const config = { schemaVersion: 1, workspaceId: "workspace_grok_owner", displayName: "Grok owner",
    roots: ["."], requiredAdapters: [], policy: { contextBudgetBytes: 6_000 } };
  await writeFile(configFile, JSON.stringify(config));
  const flags = await start("budget-grok");
  const first = await hook("budget-grok");
  const context = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
  config.policy.contextBudgetBytes = Buffer.byteLength(context);
  await writeFile(configFile, JSON.stringify(config));
  assert.deepEqual(ownerFlags(await hook("budget-grok")), flags);
  config.policy.contextBudgetBytes -= 1;
  await writeFile(configFile, JSON.stringify(config));
  const tooSmall = await hook("budget-grok");
  assert.equal(tooSmall.stdout, "", "hook injected partial owner credentials");
  assert.match(tooSmall.stderr, /budget.*owner arguments/i);
});
