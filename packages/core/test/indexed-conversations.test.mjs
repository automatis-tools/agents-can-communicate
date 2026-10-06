import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "../../storage-filesystem/src/store.mjs";
import { createCoordinationService } from "../src/service.mjs";
import { receiptId, recordMessageInTransaction } from "../src/conversations.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const workspaceId = "workspace_indexed_conversations";
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
async function fixture(t, backend) {
  const clock = createFakeClock("2026-09-01T18:00:00.000Z"), ids = { ...createFakeIds() };
  const root = backend === "filesystem"
    ? await realpath(await mkdtemp(path.join(tmpdir(), "acc-indexed-core-"))) : null;
  if (root) t.after(() => rm(root, { recursive: true, force: true }));
  const raw = backend === "filesystem" ? await openFilesystemStore({ root, clock, ids, workspaceId })
    : createMemoryStore({ clock, ids, workspaceId });
  const store = { ...raw, transaction(callback, options) {
    return raw.transaction(tx => callback({ ...tx, list(kind, predicate) {
      assert(!["message", "receipt"].includes(kind), `core listed ${kind}`);
      return tx.list(kind, predicate);
    } }), options);
  } };
  const service = createCoordinationService({ store, clock, ids });
  const open = participantId => service.openSession({ workspaceId, participantId,
    harness: participantId, heartbeatCadenceMs: 60_000 });
  const sender = await open("sender"), reader = await open("reader"), peer = await open("peer");
  const input = (key, extra = {}) => ({ ...owner(sender), clientMessageId: key,
    toParticipantIds: ["reader"], kind: "note", obligation: "none",
    subject: "Indexed message", body: "Unchanged body", ...extra });
  return { raw, store, service, clock, ids, sender, reader, peer, input };
}

for (const backend of ["memory", "filesystem"]) {
  test(`${backend}: send, reply and finish never list messages or receipts`, async t => {
    const f = await fixture(t, backend);
    const first = await f.service.sendMessage(f.input("first", { toParticipantIds: ["reader"] }));
    assert.equal((await f.service.sendMessage(f.input("first", { toParticipantIds: ["reader"] })))
      .messageId, first.messageId);
    await assert.rejects(f.service.sendMessage(f.input("first", { body: "Changed" })),
      { code: EXIT.CONFLICT });
    const replyInput = { ...owner(f.reader), messageId: first.messageId,
      clientMessageId: "reply", body: "Answer" };
    const replied = await f.service.replyToMessage(replyInput);
    assert.equal((await f.service.replyToMessage(replyInput)).reply.messageId, replied.reply.messageId);
    assert.equal(replied.reply.threadId, first.messageId);
    const finishInput = { ...owner(f.sender), clientMessageId: "finish", goal: "Done",
      toParticipantId: "reader" };
    const finished = await f.service.finishSession(finishInput);
    assert.equal((await f.service.finishSession(finishInput)).message.messageId,
      finished.message.messageId);
    assert.equal(finished.session.state, "closed");
  });

  test(`${backend}: duplicate generic keys preserve the original eager first match`, async t => {
    const f = await fixture(t, backend);
    const first = await f.service.sendMessage(f.input("duplicate"));
    await f.raw.transaction(tx => {
      tx.put("message", "message_z", { ...first, messageId: "message_z", threadId: "message_z" });
      tx.put("message", "message_a", { ...first, messageId: "message_a", threadId: "message_a" });
    });
    const expected = await f.raw.transaction(tx => tx.list("message",
      message => message.clientMessageId === "duplicate").at(0));
    assert.equal((await f.service.sendMessage(f.input("duplicate"))).messageId, expected.messageId);
  });

  test(`${backend}: staged decisions inherit actual receipts including offline peers`, async t => {
    const f = await fixture(t, backend);
    await f.service.closeSession(owner(f.reader));
    const result = await f.store.transaction(async tx => {
      const first = await recordMessageInTransaction({ tx, session: f.sender, ids: f.ids,
        messageId: "message_staged", now: f.clock.now(), input: f.input("staged", {
          kind: "decision", obligation: "acknowledge" }) });
      return recordMessageInTransaction({ tx, session: f.peer, ids: f.ids,
        messageId: "message_replacement", now: f.clock.now(), input: f.input("replacement", {
          kind: "decision", toParticipantIds: [], supersedes: [first.message.messageId] }) });
    }, { kinds: ["participant", "session", "message", "receipt"], exactKinds: ["message", "receipt"] });
    assert.deepEqual(result.message.toParticipantIds, ["reader", "sender"]);
    assert.deepEqual(result.recipientParticipantIds, ["reader", "sender"]);
  });

  for (const collision of ["message", "receipt"]) {
    test(`${backend}: generated ${collision} ID collisions roll back records and events`, async t => {
      const f = await fixture(t, backend);
      const first = await f.service.sendMessage(f.input("existing"));
      const collidingId = collision === "message" ? first.messageId : "message_collision";
      if (collision === "receipt") await f.raw.transaction(tx => {
        tx.put("receipt", receiptId(collidingId, "reader"), {
          schemaVersion: SCHEMA_VERSION, messageId: collidingId, workspaceId,
          recipientParticipantId: "reader", state: "queued", updatedAt: f.clock.now() });
      });
      const before = await f.raw.snapshot(workspaceId);
      const events = await f.raw.eventsSince(workspaceId, null, 500);
      const next = f.ids.next.bind(f.ids);
      f.ids.next = kind => kind === "message" ? collidingId : next(kind);
      await assert.rejects(f.service.sendMessage(f.input("colliding")), { code: EXIT.CONFLICT });
      assert.deepEqual(await f.raw.snapshot(workspaceId), before);
      assert.deepEqual(await f.raw.eventsSince(workspaceId, null, 500), events);
    });
  }

  test(`${backend}: a session replaced while its writer waits still conflicts`, async t => {
    const f = await fixture(t, backend), original = f.store.transaction;
    let release, announceHeld, announceRequest;
    const held = new Promise(resolve => { announceHeld = resolve; });
    const requested = new Promise(resolve => { announceRequest = resolve; });
    const pause = new Promise(resolve => { release = resolve; });
    const blocker = f.raw.transaction(async tx => {
      announceHeld();
      await pause;
      tx.put("session", f.sender.sessionId, { ...f.sender, generation: "generation_replaced" },
        tx.generationOf("session", f.sender.sessionId));
    }, { kinds: ["session"] });
    await held;
    f.store.transaction = (callback, options) => {
      const result = original(callback, options);
      if (options?.kinds?.includes("message")) announceRequest();
      return result;
    };
    const sending = f.service.sendMessage(f.input("stale"));
    sending.catch(() => {});
    try { await requested; }
    finally { release(); await blocker; }
    await assert.rejects(sending, { code: EXIT.CONFLICT });
    assert.deepEqual((await f.raw.snapshot(workspaceId)).messages, []);
  });
}

test("selecting exact conversation reads reports an incompatible custom port", async t => {
  const f = await fixture(t, "memory"), original = f.store.transaction;
  f.store.transaction = (callback, options) => original(tx => callback({ ...tx,
    load: undefined, lookup: undefined }), options);
  await assert.rejects(f.service.sendMessage(f.input("unsupported")),
    error => error.code === EXIT.USAGE && /exact transaction port/.test(error.message));
});
