import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCoordinationService } from "../../packages/core/src/service.mjs";
import { openFilesystemStore } from "../../packages/storage-filesystem/src/store.mjs";
import { createFakeClock, createFakeIds } from "../helpers/memory-store.mjs";

const NOW = "2026-09-01T21:00:00.000Z";
const WORKSPACE = "workspace_delivery_v2";

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-delivery-v2-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = await openFilesystemStore({ root, clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids });
  const opening = participantId => ({ workspaceId: WORKSPACE, participantId,
    displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000 });
  const sender = await service.openSession(opening("sender"));
  const recipient = await service.openSession(opening("recipient"));
  return { store, service, sender, recipient };
}

const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

test("durable delivery evidence advances queued to offered to retrieved", async t => {
  const { store, service, sender, recipient } = await place(t);
  const message = await service.sendMessage({ ...owner(sender),
    clientMessageId: "client_process_delivery", toParticipantIds: ["recipient"],
    kind: "question", obligation: "reply", subject: "Store seam",
    body: "Which names are stable?" });

  assert.deepEqual((await store.snapshot(WORKSPACE)).receipts.map(item => item.state),
    ["queued"]);
  const offered = await service.recordOfferSucceeded({ messageId: message.messageId,
    recipientParticipantId: "recipient", targetSessionId: recipient.sessionId,
    targetGeneration: recipient.generation, transport: "process-fixture", adapterId: "test",
    clientVersion: "1.0.0" });
  assert.equal(offered.state, "offered");
  const [retrieved] = await service.readInbox({ ...owner(recipient),
    messageId: message.messageId });
  assert.equal(retrieved.receipt.state, "retrieved");
});

test("transport rejection remains an event and never becomes failed delivery state", async t => {
  const { store, service, sender } = await place(t);
  const message = await service.sendMessage({ ...owner(sender),
    clientMessageId: "client_process_failure", toParticipantIds: ["recipient"],
    kind: "decision", obligation: "acknowledge", subject: "Store seam",
    body: "Use the durable record." });

  const event = await service.recordOfferFailed({ messageId: message.messageId,
    recipientParticipantId: "recipient", actorSessionId: sender.sessionId,
    transport: "process-fixture", adapterId: "test", clientVersion: "1.0.0",
    safeErrorCode: "transport_rejected" });

  assert.equal(event.type, "message.offer_failed");
  assert.deepEqual((await store.snapshot(WORKSPACE)).receipts.map(item => item.state),
    ["queued"]);
});
