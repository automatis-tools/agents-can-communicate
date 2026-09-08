import assert from "node:assert/strict";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { crashHolderWithWaitingHook } from "../helpers/waiter-hook-crash.mjs";

// Omitting recovery after lifecycle acquisition loses the pre-bound generation:
// the waiter sees no published session, replaces its binding, then cannot write
// over the crashed holder's pending journal. A later retry creates another owner.
test("an installed hook waiter recovers a crashed holder before replacing its binding", async t => {
  const packed = await createPackedAcc(t);
  await packed.acc(["attach", "--participant", "peer1"]);
  await packed.acc(["attach", "--participant", "peer2"]);
  const participantId = "waiter-crash-writer";
  const payload = { hook_event_name: "SessionStart", session_id: "native-waiter-crash",
    cwd: packed.project, source: "startup" };
  const { original, afterWaiter } = await crashHolderWithWaitingHook(packed,
    { payload, participantId });
  await packed.hook("claude_code", payload, { ACC_PARTICIPANT: participantId });
  const afterRetry = await packed.findBinding(payload.session_id);
  const rows = (await packed.acc(["status"])).participants
    .filter(participant => participant.participantId === participantId);
  const owner = binding => ({ sessionId: binding?.accSessionId, generation: binding?.generation });

  assert.deepEqual(owner(afterWaiter), owner(original), "the waiter discarded the journalled owner");
  assert.deepEqual(owner(afterRetry), owner(original), "the retry changed the recovered generation");
  assert.deepEqual(rows.map(row => row.sessionId), [original.accSessionId]);
  await packed.acc(["heartbeat", "--session", original.accSessionId,
    "--generation", original.generation]);
});
