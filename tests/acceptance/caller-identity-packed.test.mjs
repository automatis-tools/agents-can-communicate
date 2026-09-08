import assert from "node:assert/strict";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// The outsider inherits a parent client ID. Neither it nor a sole binding
// proves the caller owns that session.
const outsiderEnv = { CODEX_THREAD_ID: "native-outsider", CLAUDE_CODE_SESSION_ID: "native-peer" };

async function stage(t) {
  const packed = await createPackedAcc(t);
  const peer = await packed.start({ adapterId: "claude_code", participantId: "peer",
    harnessSessionId: "native-peer" });
  const peerEnv = await packed.ownerEnv("native-peer");
  const sender = await packed.acc(["attach", "--participant", "sender"]);
  const senderFlags = ["--session", sender.sessionId, "--generation", sender.generation];
  const sent = await packed.acc(["request", ...senderFlags, "--to", "peer",
    "--title", "Review the change"]);
  const claim = await packed.acc(["claim", "--resource", "file:owned.mjs"], peerEnv);
  await packed.acc(["work", "--summary", "the peer's actual intent"], peerEnv);
  return { packed, peer, peerEnv, sender, senderFlags, messageId: sent.message.messageId,
    claimId: claim.claimId };
}

const snapshot = packed => packed.acc(["sync", "--scope", "full"], outsiderEnv)
  .then(value => value.snapshot);

for (const named of [false, true]) {
  test(`installed CLI refuses an unbound caller${named ? " naming the peer's public ID" : " with one peer"}`,
    async t => {
      const { packed, peer, messageId, claimId } = await stage(t);
      const before = await snapshot(packed);
      const flags = named ? ["--session", peer.sessionId] : [];
      for (const args of [
        ["work", "--summary", "wrong author"],
        ["claim", "--resource", "file:outsider.mjs"],
        ["message", "--to", "sender", "--subject", "wrong author", "--body", "no"],
        ["request", "--to", "sender", "--title", "wrong author"],
        ["inbox", "--message", messageId],
        ["reply", "--message", messageId, "--body", "wrong author"],
        ["ack", "--message", messageId],
        ["release", "--claim", claimId],
        ["finish", "--goal", "wrong author"],
      ]) {
        await t.test(args[0], async () => {
          const error = await packed.accError([...args, ...flags], named ? outsiderEnv : {});
          assert.notEqual(error, null, `${args[0]} acted as the only peer`);
          assert.equal(error.code, 2, error.stdout);
          assert.equal(JSON.parse(error.stdout).error.details.reasonCode, "caller_identity_unresolved");
        });
      }
      assert.deepEqual(await snapshot(packed), before,
        "an unidentified caller changed the peer's state or delivery receipts");
    });
}

test("installed reads do not borrow peer attention, while explicit owners can communicate", async t => {
  const { packed, peer, peerEnv, sender, senderFlags, messageId } = await stage(t);
  for (const command of ["status", "sync"]) {
    const other = await packed.acc([command], outsiderEnv);
    assert.equal(other.attention.some(item => item.sourceId === messageId), false);
    const own = await packed.acc([command], peerEnv);
    assert.equal(own.attention.some(item => item.sourceId === messageId), true);
  }
  const worked = await packed.acc(["work", "--session", peer.sessionId,
    "--summary", "still the peer"], peerEnv);
  assert.equal(worked.sessionId, peer.sessionId);
  const sent = await packed.acc(["message", ...senderFlags, "--to", "peer",
    "--subject", "manual owner", "--body", "explicit pair"]);
  assert.equal(sent.message.fromSessionId, sender.sessionId);
  const [received] = await packed.acc(["inbox", "--message", sent.message.messageId], peerEnv);
  assert.equal(received.message.messageId, sent.message.messageId);
  const reply = await packed.acc(["reply", "--message", sent.message.messageId,
    "--body", "explicit owner"], peerEnv);
  assert.equal(reply.message.fromSessionId, peer.sessionId);
  const done = await packed.acc(["finish", "--goal", "review complete"], peerEnv);
  assert.equal(done.message.fromSessionId, peer.sessionId);
});

test("a public session selector cannot replace a different caller's explicit pair", async t => {
  const { packed, peer } = await stage(t);
  await packed.start({ adapterId: "codex", participantId: "author",
    harnessSessionId: "native-author" });
  const ownEnv = await packed.ownerEnv("native-author");
  const before = await snapshot(packed);
  const error = await packed.accError(["work", "--session", peer.sessionId,
    "--summary", "wrong peer"], ownEnv);
  assert.notEqual(error, null, "a public peer ID selected somebody else's generation");
  assert.equal(error.code, 2);
  assert.deepEqual(await snapshot(packed), before);
});
