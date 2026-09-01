import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../../packages/core/src/service.mjs";
import { openFilesystemStore } from "../../packages/storage-filesystem/src/store.mjs";
import { createFakeClock, createFakeIds } from "../helpers/memory-store.mjs";

const WORKSPACE = "workspace_recipient_v2";

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-recipient-v2-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock("2026-09-01T23:00:00.000Z");
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
const sending = (sender, overrides = {}) => ({ ...owner(sender),
  clientMessageId: "client_recipient", toParticipantIds: ["recipient"], kind: "question",
  obligation: "reply", subject: "Physics", body: "Can you review?", ...overrides });

test("an unknown participant is refused without a durable message", async t => {
  const { store, service, sender } = await place(t);

  await assert.rejects(service.sendMessage(sending(sender,
    { toParticipantIds: ["physcis"] })),
  error => error.code === EXIT.DATA && /no participant here is called physcis/.test(error.message)
    && /recipient, sender/.test(error.message));
  assert.deepEqual((await store.snapshot(WORKSPACE)).messages, []);
});

test("a known participant with no open session remains addressable and is unavailable",
  async t => {
    const { service, sender, recipient } = await place(t);
    await service.closeSession(owner(recipient));

    const message = await service.sendMessage(sending(sender));
    const status = await service.sync({ sessionId: sender.sessionId });

    assert.equal(message.toParticipantIds[0], "recipient");
    assert.deepEqual(status.attention.map(item => item.kind), ["recipient_unavailable"]);
  });

test("message validation runs before recipient lookup", async t => {
  const { service, sender } = await place(t);

  await assert.rejects(service.sendMessage(sending(sender, {
    toParticipantIds: ["nobody"], body: `${String.fromCharCode(27)}[2Jcleared` })),
  error => error.code === EXIT.DATA && /control characters/i.test(error.message));
});
