import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// These are process/packaging contracts, not evidence that a model uses the
// context. The real-client observation is recorded separately in COMPATIBILITY.
function ownerFlags(context) {
  const match = /^ACC CLI \(append\): --session (\S+) --generation (\S+)$/m.exec(context);
  assert.ok(match, `the hook gave its session no usable owner arguments:\n${context}`);
  return ["--session", match[1], "--generation", match[2]];
}

async function stage(t, budgetBytes = 6_000, queued = true) {
  const packed = await createPackedAcc(t);
  await writeFile(path.join(packed.project, "acc.workspace.json"), JSON.stringify({
    schemaVersion: 1, workspaceId: "workspace_hook_owner", displayName: "hook owner",
    roots: ["."], requiredAdapters: [], policy: { contextBudgetBytes: budgetBytes },
  }));
  const sender = await packed.acc(["attach", "--participant", "sender"]);
  const senderFlags = ["--session", sender.sessionId, "--generation", sender.generation];
  const reader = await packed.start({ adapterId: "claude_code", participantId: "reader",
    harnessSessionId: "native-reader" });
  const question = queued ? await packed.acc(["request", ...senderFlags, "--to", "reader",
    "--title", "receipt review", "--detail", "A long question. ".repeat(60)]) : null;
  const turn = async () => {
    const output = await packed.beforeTurn({ adapterId: "claude_code",
      harnessSessionId: "native-reader" });
    const context = output.stdout.trim() === "" ? ""
      : JSON.parse(output.stdout).hookSpecificOutput.additionalContext;
    return { ...output, context };
  };
  return { packed, reader, question, senderFlags, turn };
}

test("the installed hook provides its own pair for intent, claim and addressed reply", async t => {
  const { packed, reader, question, turn } = await stage(t);
  const flags = ownerFlags((await turn()).context);
  assert.equal(flags[1], reader.sessionId);
  for (const command of ["status", "sync"]) {
    const own = await packed.acc([command, ...flags]);
    assert.ok(own.attention.some(item => item.sourceId === question.message.messageId));
  }
  const intent = await packed.acc(["work", ...flags, "--summary", "review receipts"]);
  assert.equal(intent.sessionId, reader.sessionId);
  const claim = await packed.acc(["claim", ...flags, "--resource", "file:receipts.mjs"]);
  assert.equal(claim.ownerSessionId, reader.sessionId);
  const [received] = await packed.acc(["inbox", ...flags,
    "--message", question.message.messageId]);
  assert.equal(received.message.messageId, question.message.messageId);
  const reply = await packed.acc(["reply", ...flags, "--message", question.message.messageId,
    "--body", "retrieval precedes acknowledgement"]);
  assert.equal(reply.message.fromSessionId, reader.sessionId);
  const state = await packed.acc(["sync", "--scope", "full"]);
  assert.equal(state.snapshot.receipts.find(item => item.messageId === question.message.messageId
    && item.recipientParticipantId === "reader").state, "acknowledged");
  const done = await packed.acc(["finish", ...flags, "--goal", "review complete"]);
  assert.equal(done.message.fromSessionId, reader.sessionId);
});

test("200 bytes retain both complete owner arguments and an executable inbox recovery", async t => {
  const { packed, question, turn } = await stage(t, 200);
  const { context } = await turn();
  assert.ok(Buffer.byteLength(context) <= 200);
  const flags = ownerFlags(context);
  assert.match(context, new RegExp(`acc inbox --message ${question.message.messageId}`));
  const [item] = await packed.acc(["inbox", ...flags, "--message", question.message.messageId]);
  assert.equal(item.message.body, "A long question. ".repeat(60));
  assert.equal(item.receipt.state, "retrieved");
});

test("a budget smaller than the pair keeps recovery truthful and reports the missing credentials", async t => {
  const { question, turn } = await stage(t, 84);
  const { context, stderr } = await turn();
  assert.ok(Buffer.byteLength(context) <= 84);
  assert.doesNotMatch(context, /--generation|--session/);
  assert.match(context, new RegExp(`acc inbox --message ${question.message.messageId}`));
  assert.match(stderr, /budget.*owner arguments/i);
});

test("an ambient turn reserves the owner line before truncating the peer notice", async t => {
  const { turn } = await stage(t, 120, false);
  const flags = ownerFlags((await turn()).context);
  const { context } = await turn();
  assert.ok(Buffer.byteLength(context) <= 120, context);
  assert.deepEqual(ownerFlags(context), flags);
});

test("a pair that fits alone cannot silently displace pending-message recovery", async t => {
  const { question, turn } = await stage(t, 150);
  const { context, stderr } = await turn();
  assert.ok(Buffer.byteLength(context) <= 150);
  assert.match(context, new RegExp(`acc inbox --message ${question.message.messageId}`));
  assert.match(stderr, /budget.*owner arguments/i);
});

test("same-client sessions get distinct pairs and a restarted session rejects the old pair", async t => {
  const { packed, reader, turn } = await stage(t);
  const first = ownerFlags((await turn()).context);
  const second = await packed.start({ adapterId: "claude_code", participantId: "second",
    harnessSessionId: "native-second" });
  const output = await packed.beforeTurn({ adapterId: "claude_code",
    harnessSessionId: "native-second" });
  const secondFlags = ownerFlags(JSON.parse(output.stdout).hookSpecificOutput.additionalContext);
  assert.equal(secondFlags[1], second.sessionId);
  assert.notEqual(secondFlags[1], reader.sessionId);
  await packed.acc(["finish", ...first, "--goal", "first incarnation complete"]);
  const replacement = await packed.start({ adapterId: "claude_code", participantId: "reader",
    harnessSessionId: "native-reader" });
  const fresh = ownerFlags((await turn()).context);
  assert.equal(fresh[1], replacement.sessionId);
  assert.notDeepEqual(fresh, first);
  const stale = await packed.accError(["work", ...first, "--summary", "stale"]);
  assert.ok(stale, "the closed generation was accepted");
  const intent = await packed.acc(["work", ...fresh, "--summary", "fresh"]);
  assert.equal(intent.sessionId, replacement.sessionId);
});

test("a remaining own claim does not make an otherwise solo turn print credentials", async t => {
  const { packed, senderFlags, turn } = await stage(t, 6_000, false);
  const flags = ownerFlags((await turn()).context);
  await packed.acc(["claim", ...flags, "--resource", "file:mine.mjs"]);
  await packed.acc(["detach", ...senderFlags]);
  assert.equal((await turn()).context, "");
  const configFile = path.join(packed.project, "acc.workspace.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.policy.contextBudgetBytes = 84;
  await writeFile(configFile, JSON.stringify(config));
  const quiet = await turn();
  assert.equal(quiet.context, "");
  assert.equal(quiet.stderr, "");
});
