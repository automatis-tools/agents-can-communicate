import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);

test("installed reply exposes the original acknowledgement and supports exact inspection", async t => {
  const packed = await createPackedAcc(t);
  const sender = await packed.acc(["attach", "--participant", "sender"]);
  const reader = await packed.acc(["attach", "--participant", "reader"]);
  const owner = session => ["--session", session.sessionId, "--generation", session.generation];
  const sent = await packed.acc(["request", ...owner(sender), "--to", "reader",
    "--title", "Verify receipt", "--detail", "Does reply acknowledge the original?"]);
  const replyArgs = ["reply", ...owner(reader), "--message", sent.message.messageId,
    "--body", "Yes, atomically.", "--client-message-id", "client_verified_reply"];

  const reply = await packed.acc(replyArgs);

  assert.notEqual(reply.message.messageId, sent.message.messageId);
  assert.equal(reply.message.inReplyTo, sent.message.messageId);
  assert.equal(reply.receipt.messageId, sent.message.messageId);
  assert.equal(reply.receipt.recipientParticipantId, "reader");
  assert.equal(reply.receipt.state, "acknowledged");
  const before = await packed.acc(["sync", "--scope", "full"]);
  const [inspected] = await packed.acc(["inbox", ...owner(reader),
    "--message", sent.message.messageId]);
  assert.deepEqual(inspected.receipt, reply.receipt);
  assert.equal(inspected.message.body, "Does reply acknowledge the original?");
  assert.deepEqual(await packed.acc(["inbox", ...owner(reader)]), { items: [], nextCursor: null });

  // An idempotent retry exercises the actual human formatter without creating
  // another answer. It must distinguish the outgoing reply from the original.
  const human = await run(process.execPath, [packed.accBin, ...replyArgs,
    "--cwd", packed.project], { cwd: packed.project, env: packed.env });
  assert.match(human.stdout, new RegExp(`recorded ${reply.message.messageId}`));
  assert.match(human.stdout, new RegExp(`acknowledged ${sent.message.messageId}`));
  assert.deepEqual(await packed.acc(["sync", "--scope", "full"]), before,
    "inspection or an exact reply retry changed durable state");

  const stranger = await packed.acc(["attach", "--participant", "stranger"]);
  const denied = await packed.accError(["inbox", ...owner(stranger),
    "--message", sent.message.messageId]);
  assert.equal(denied?.code, 5, "a resolved message became readable by another participant");
});
