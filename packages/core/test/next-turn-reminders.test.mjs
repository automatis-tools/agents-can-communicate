import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

test("reminders require this participant's offered or retrieved unresolved obligation", async () => {
  const workspaceId = "workspace_reminders";
  const clock = createFakeClock("2026-08-01T12:00:00.000Z");
  const ids = createFakeIds();
  const store = createMemoryStore({ workspaceId, clock, ids });
  const service = createCoordinationService({ store, clock, ids });
  const open = participantId => service.openSession({ workspaceId, participantId,
    harness: "fixture", heartbeatCadenceMs: 30_000 });
  const sender = await open("sender");
  const reader = await open("reader");
  const other = await open("other");
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  const expected = [], queued = [];
  for (const [label, state, obligation, recipient, recipients] of [
    ["queued", "queued", "reply", reader, ["reader"]],
    ["offered", "offered", "reply", reader, ["reader"]],
    ["retrieved", "retrieved", "acknowledge", reader, ["reader"]],
    ["resolved", "acknowledged", "reply", reader, ["reader"]],
    ["no-obligation", "retrieved", "none", reader, ["reader"]],
    ["foreign-only", "retrieved", "reply", other, ["other"]],
    ["other-read-first", "retrieved", "reply", other, ["reader", "other"]],
  ]) {
    const message = await service.sendMessage({ ...owner(sender), clientMessageId: label,
      toParticipantIds: recipients, kind: obligation === "reply" ? "request" : "decision",
      obligation, subject: label, body: label });
    if (state === "offered") await service.recordOfferSucceeded({
      messageId: message.messageId, recipientParticipantId: recipient.participantId,
      targetSessionId: recipient.sessionId, targetGeneration: recipient.generation,
      transport: "next-turn", adapterId: "fixture", clientVersion: "1.0.0" });
    if (state === "retrieved") await service.readInbox({ ...owner(recipient),
      messageId: message.messageId });
    if (state === "acknowledged") await service.acknowledgeMessage({ ...owner(recipient),
      messageId: message.messageId });
    if (["offered", "retrieved"].includes(label)) expected.push(message.messageId);
    if (["queued", "other-read-first"].includes(label)) queued.push(message.messageId);
  }
  const before = await store.snapshot(workspaceId);
  const delivery = await service.nextTurnDelivery({ workspaceId, participantId: "reader",
    exceptSessionId: reader.sessionId });
  assert.deepEqual(delivery.reminderMessageIds, expected);
  assert.deepEqual(delivery.queuedMessages.map(item => item.messageId), queued);
  assert.deepEqual((await service.nextTurnDelivery({ workspaceId })).reminderMessageIds, []);
  assert.deepEqual(await store.snapshot(workspaceId), before,
    "classifying context must not change messages or receipts");
});
