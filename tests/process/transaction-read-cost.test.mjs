import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EXIT } from "@agents-can-communicate/protocol";
import { createCoordinationService } from "../../packages/core/src/service.mjs";
import { openFilesystemStore } from "../../packages/storage-filesystem/src/store.mjs";
import { createFakeClock, createFakeIds } from "../helpers/memory-store.mjs";
import { createStoreIoProbe } from "../helpers/store-io-probe.mjs";

const workspaceId = "workspace_read_cost";
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-read-cost-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock("2026-09-01T21:00:00.000Z"), ids = createFakeIds();
  const store = await openFilesystemStore({ root, workspaceId, clock, ids });
  const service = createCoordinationService({ store, clock, ids });
  const open = participantId => service.openSession({ workspaceId, participantId,
    harness: "fixture", heartbeatCadenceMs: 60_000 });
  const sender = await open("sender"), reader = await open("reader");
  const send = key => service.sendMessage({ ...owner(sender), clientMessageId: key,
    toParticipantIds: ["reader"], kind: "note", obligation: "none",
    subject: key, body: "Same measured fixture" });
  const offer = message => ({ messageId: message.messageId, recipientParticipantId: "reader",
    targetSessionId: reader.sessionId, targetGeneration: reader.generation,
    transport: "next-turn", adapterId: "fixture", clientVersion: "1.0.0" });
  return { root, store, service, clock, sender, reader, send, offer, ids };
}

test("steady sends do not scale primary reads with backlog; receipts read only their named state records", async t => {
  const f = await fixture(t), messages = [];
  const probe = createStoreIoProbe(f.root);
  t.after(() => probe.stop());
  const sends = {};
  for (let i = 0; i < 60; i++) {
    const measured = await probe.capture(() => f.send(`client_${i}`));
    assert.equal(measured.indexFlushes, 0, "index bytes and publications never flush");
    messages.push(measured.result);
    if ([1, 20, 40, 60].includes(i + 1)) sends[i + 1] = measured;
  }
  assert.equal(sends[20].stateReads, sends[40].stateReads);
  assert.equal(sends[40].stateReads, sends[60].stateReads);
  assert(sends[20].stateReads > 0, "the probe observes actual primary reads");
  for (const measurement of Object.values(sends)) {
    assert(measurement.pageWrites > 0, "page publication counters are active");
  }
  const read = await probe.capture(() => f.service.readReceipt(f.offer(messages[0])));
  const offered = await probe.capture(() => f.service.recordOfferSucceeded(f.offer(messages[0])));
  const ack = await probe.capture(() => f.service.acknowledgeMessage({ ...owner(f.reader),
    messageId: messages[0].messageId }));
  const failed = await probe.capture(() => f.service.recordOfferFailed({ ...f.offer(messages[1]),
    safeErrorCode: "transport_rejected" }));
  t.diagnostic(JSON.stringify({ sends, read, offered, ack, failed }));
  assert.equal(read.stateReads, 2);
  assert.deepEqual(read.stateByKind, { receipt: 1, message: 1 });
  assert.equal(offered.stateReads, 3);
  assert.equal(ack.stateReads, 4, "including the owner lookup outside the writer");
  assert.equal(failed.stateReads, 3);
  assert.equal(read.result.state, "queued");
  assert.equal(offered.result.state, "offered");
  assert.equal(ack.result.state, "acknowledged");
  const reopened = await openFilesystemStore({ root: f.root, workspaceId,
    clock: f.clock, ids: f.ids });
  const coldService = createCoordinationService({ store: reopened, clock: f.clock, ids: f.ids });
  const cold = await probe.capture(() => coldService.readReceipt(f.offer(messages[0])));
  assert.equal(cold.stateReads, 2);
  assert.equal(cold.result.state, "acknowledged");
  const reopenedRetry = await probe.capture(() => coldService.sendMessage({ ...owner(f.sender),
    clientMessageId: "client_0", toParticipantIds: ["reader"], kind: "note", obligation: "none",
    subject: "client_0", body: "Same measured fixture" }));
  assert.equal(reopenedRetry.result.messageId, messages[0].messageId);
  assert.equal(reopenedRetry.stateByKind.message, 1);
  assert.equal(reopenedRetry.stateByKind.receipt ?? 0, 0, "reopen never scans unrelated recipients");
  await rm(path.join(f.root, "indexes"), { recursive: true });
  const recovery = await probe.capture(() => coldService.sendMessage({ ...owner(f.sender),
    clientMessageId: "client_0", toParticipantIds: ["reader"], kind: "note", obligation: "none",
    subject: "client_0", body: "Same measured fixture" }));
  assert.equal(recovery.result.messageId, messages[0].messageId);
  assert(recovery.stateReads >= 120, "forced cache recovery is measured separately");
  assert.equal(recovery.indexFlushes, 0);
  t.diagnostic(JSON.stringify({ cold, reopenedRetry, recovery }));
});

test("an offer whose semantic owner is replaced while waiting refuses without changing its receipt", async t => {
  const f = await fixture(t), message = await f.send("client_waiting");
  let announceHeld, release, announceRequested;
  const held = new Promise(resolve => { announceHeld = resolve; });
  const requested = new Promise(resolve => { announceRequested = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const blocker = f.store.transaction(async tx => {
    announceHeld(); await pause;
    tx.put("session", f.reader.sessionId, { ...f.reader, generation: "generation_replaced" },
      tx.generationOf("session", f.reader.sessionId));
  }, { kinds: ["session"] });
  await held;
  const wrapped = { ...f.store, transaction(callback, options) {
    const result = f.store.transaction(callback, options);
    announceRequested();
    return result;
  } };
  const service = createCoordinationService({ store: wrapped, clock: f.clock, ids: f.ids });
  const offered = service.recordOfferSucceeded(f.offer(message));
  offered.catch(() => {});
  try { await requested; }
  finally { release(); await blocker; }
  await assert.rejects(offered, { code: EXIT.CONFLICT });
  assert.equal((await f.service.readReceipt(f.offer(message))).state, "queued");
});

test("exact receipt operations refuse a surviving orphan without publishing events", async t => {
  const f = await fixture(t), message = await f.send("client_orphan");
  await f.store.transaction(tx => tx.remove("message", message.messageId,
    tx.generationOf("message", message.messageId)), { kinds: ["message"] });
  const events = await f.store.eventsSince(workspaceId, null, 100);
  for (const operation of [
    () => f.service.readReceipt(f.offer(message)),
    () => f.service.recordOfferSucceeded(f.offer(message)),
    () => f.service.recordOfferFailed({ ...f.offer(message), safeErrorCode: "transport_rejected" }),
    () => f.service.acknowledgeMessage({ ...owner(f.reader), messageId: message.messageId }),
  ]) await assert.rejects(operation(), { code: EXIT.CONFLICT });
  assert.deepEqual(await f.store.eventsSince(workspaceId, null, 100), events);
});
