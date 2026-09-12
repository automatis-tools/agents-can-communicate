import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const workspaceId = "workspace_ack_contract";
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

async function fixture() {
  const clock = createFakeClock("2026-09-12T12:00:00.000Z"), ids = createFakeIds();
  const store = createMemoryStore({ workspaceId, clock, ids });
  const service = createCoordinationService({ store, clock, ids });
  const open = participantId => service.openSession({ workspaceId, participantId,
    harness: "fixture", heartbeatCadenceMs: 60_000 });
  const sender = await open("sender"), reader = await open("reader");
  return { clock, store, service, sender, reader };
}

// Removing the obligation check must fail for both reply-required kinds at
// every unresolved receipt state, without letting the rejected ack hide mail.
for (const kind of ["question", "request"]) {
  for (const state of ["queued", "offered", "retrieved"]) {
    test(`bare ack cannot resolve a ${state} ${kind}`, async () => {
      const f = await fixture();
      const message = await f.service.sendMessage({ ...owner(f.sender),
        clientMessageId: "client_request", toParticipantIds: ["reader"], kind,
        obligation: "reply", subject: "Check the gate", body: "Report the result." });
      const input = { ...owner(f.reader), messageId: message.messageId };
      if (state === "offered") await f.service.recordOfferSucceeded({
        messageId: message.messageId, recipientParticipantId: "reader",
        targetSessionId: f.reader.sessionId, targetGeneration: f.reader.generation,
        transport: "next-turn", adapterId: "fixture", clientVersion: "1.0.0" });
      if (state === "retrieved") await f.service.readInbox(input);
      const before = await f.store.snapshot(workspaceId);
      const events = await f.store.eventsSince(workspaceId, null, 100);

      await assert.rejects(f.service.acknowledgeMessage(input),
        error => error.code === EXIT.CONFLICT && /reply/.test(error.message));

      assert.deepEqual(await f.store.snapshot(workspaceId), before);
      assert.deepEqual(await f.store.eventsSince(workspaceId, null, 100), events);
      const page = await f.service.listInbox(owner(f.reader));
      assert.deepEqual(page.items.map(item => item.message.messageId), [message.messageId]);
      assert.equal(page.items[0].receipt.state, state);
      const status = await f.service.collectStatus({ participantId: "reader" });
      assert.ok(status.attention.some(item => item.kind === "reply_required"
        && item.sourceId === message.messageId));
    });
  }
}

// Restoring the old "already resolved" guard must fail: an acknowledgement
// cannot close the conversation, irrespective of the sender's handoff status.
for (const status of ["complete", "partial", "blocked"]) {
  test(`an acknowledged ${status} handoff can receive acceptance and a later result`, async () => {
    const f = await fixture();
    const { message } = await f.service.finishSession({ ...owner(f.sender),
      clientMessageId: "client_finish", toParticipantId: "reader", status,
      goal: "Check the gate", completed: ["context preserved"], remaining: ["check locally"] });
    const input = { ...owner(f.reader), messageId: message.messageId };
    const receipt = await f.service.acknowledgeMessage(input);
    const before = await f.store.eventsSince(workspaceId, null, 100);
    f.clock.advance(5_000);

    const acceptance = await f.service.replyToMessage({ ...input,
      clientMessageId: "client_acceptance", body: "I take the local gate check only." });
    const resultInput = { ...input, clientMessageId: "client_result", body: "The gate passes." };
    const result = await f.service.replyToMessage(resultInput);
    assert.notEqual(result.reply.messageId, acceptance.reply.messageId);
    for (const response of [acceptance, result]) {
      assert.equal(response.reply.kind, "answer");
      assert.equal(response.reply.inReplyTo, message.messageId);
      assert.equal(response.reply.threadId, message.threadId);
      assert.deepEqual(response.reply.toParticipantIds, ["sender"]);
      assert.deepEqual(response.receipt, receipt);
    }
    const after = await f.store.eventsSince(workspaceId, null, 100);
    assert.deepEqual(after.events.slice(before.events.length).map(event => event.type),
      ["message.recorded", "message.recorded"]);
    const snapshot = await f.store.snapshot(workspaceId);
    assert.deepEqual(await f.service.replyToMessage(resultInput), result);
    await assert.rejects(f.service.replyToMessage({ ...resultInput, body: "Different result" }),
      error => error.code === EXIT.CONFLICT && /clientMessageId/.test(error.message));
    await assert.rejects(f.service.replyToMessage({ ...input, generation: "generation_stale",
      clientMessageId: "client_stale", body: "Not mine" }), error => error.code === EXIT.CONFLICT);
    assert.deepEqual(await f.store.snapshot(workspaceId), snapshot);
    assert.deepEqual(await f.store.eventsSince(workspaceId, null, 100), after);
  });
}

test("ack after a reply remains an idempotent receipt inspection", async () => {
  const f = await fixture();
  const message = await f.service.sendMessage({ ...owner(f.sender),
    clientMessageId: "client_request", toParticipantIds: ["reader"], kind: "request",
    obligation: "reply", subject: "Check the gate", body: "Report the result." });
  const input = { ...owner(f.reader), messageId: message.messageId };
  const { receipt } = await f.service.replyToMessage({ ...input,
    clientMessageId: "client_decline", body: "Declined: outside my user's scope." });
  const snapshot = await f.store.snapshot(workspaceId);
  const events = await f.store.eventsSince(workspaceId, null, 100);
  f.clock.advance(5_000);
  assert.deepEqual(await f.service.acknowledgeMessage(input), receipt);
  assert.deepEqual(await f.store.snapshot(workspaceId), snapshot);
  assert.deepEqual(await f.store.eventsSince(workspaceId, null, 100), events);
  assert.deepEqual((await f.service.listInbox(owner(f.reader))).items, []);
});
