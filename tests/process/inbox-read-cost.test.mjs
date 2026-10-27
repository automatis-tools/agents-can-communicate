import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCoordinationService } from "../../packages/core/src/service.mjs";
import { openFilesystemStore } from "../../packages/storage-filesystem/src/store.mjs";
import { createFakeClock, createFakeIds } from "../helpers/memory-store.mjs";
import { createStoreIoProbe } from "../helpers/store-io-probe.mjs";

// #306: an inbox read touches the reader's records, never the backlog addressed
// to other participants, and a page never the reader's acknowledged history.
const workspaceId = "workspace_inbox_cost";
const owner = session => ({ workspaceId, sessionId: session.sessionId, generation: session.generation });

async function fixture(t, failAt) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-inbox-cost-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock("2026-10-27T12:00:00.000Z"), ids = createFakeIds();
  const reopen = (options = {}) => openFilesystemStore({ root, workspaceId, clock, ids, ...options })
    .then(store => createCoordinationService({ store, clock, ids }));
  const service = await reopen();
  const open = participantId => service.openSession({ workspaceId, participantId,
    harness: "fixture", heartbeatCadenceMs: 60_000 });
  const sender = await open("sender"), reader = await open("reader");
  await open("other");
  let sent = 0;
  const send = async (to, fields = {}) => {
    clock.advance?.(1_000);
    return service.sendMessage({ ...owner(sender), clientMessageId: `client_${sent++}`, toParticipantIds: [to],
      kind: "note", obligation: "none", subject: `message ${sent}`, body: "Same measured fixture", ...fields });
  };
  return { root, service, reopen, sender, reader, send, failAt };
}

const probeOf = (t, root) => { const probe = createStoreIoProbe(root); t.after(() => probe.stop()); return probe; };

test("an exact inbox read loads its own message and receipt, whatever the backlog", async t => {
  const f = await fixture(t), probe = probeOf(t, f.root);
  const target = await f.send("reader", { kind: "question", obligation: "reply" });
  for (let index = 0; index < 20; index++) await f.send("other");
  const before = await probe.capture(() => f.service.readInbox({ ...owner(f.reader), messageId: target.messageId }));
  for (let index = 0; index < 120; index++) await f.send(index % 2 ? "other" : "reader");
  const after = await probe.capture(() => f.service.readInbox({ ...owner(f.reader), messageId: target.messageId }));
  assert.equal(after.result[0].message.messageId, target.messageId);
  assert.equal(after.stateByKind.message, 1, JSON.stringify(after.stateByKind));
  assert.equal(after.stateByKind.receipt, 1, JSON.stringify(after.stateByKind));
  assert.equal(after.stateReads, before.stateReads, "the read grew with the backlog");
});

test("a page reads the reader's pending records, whatever the backlog and the acknowledged history", async t => {
  const f = await fixture(t), probe = probeOf(t, f.root);
  const history = [];
  for (let index = 0; index < 30; index++) history.push(await f.send("reader"));
  for (const message of history) {
    await f.service.readInbox({ ...owner(f.reader), messageId: message.messageId });
    await f.service.acknowledgeMessage({ ...owner(f.reader), messageId: message.messageId });
  }
  const pending = [];
  for (let index = 0; index < 5; index++) pending.push(await f.send("reader"));
  for (let index = 0; index < 30; index++) await f.send("other");
  const before = await probe.capture(() => f.service.listInbox({ ...owner(f.reader), limit: 3 }));
  for (let index = 0; index < 150; index++) await f.send("other");
  const after = await probe.capture(() => f.service.listInbox({ ...owner(f.reader), limit: 3 }));
  assert.deepEqual(after.result.items.map(item => item.message.messageId),
    pending.slice(-3).reverse().map(message => message.messageId));
  assert.equal(after.stateReads, before.stateReads, "the page grew with the backlog");
  // The reader's five pending receipts and their messages, not its thirty acknowledged ones.
  assert.ok(after.stateByKind.receipt <= 5 + 1, JSON.stringify(after.stateByKind));
  assert.ok(after.stateByKind.message <= 5 + 1, JSON.stringify(after.stateByKind));
});

test("a page and an exact read give the same answers on every index path", async t => {
  const answers = {};
  for (const path_ of ["warm", "cold", "rebuilt", "unavailable"]) {
    const f = await fixture(t);
    const first = await f.send("reader", { kind: "decision", obligation: "acknowledge" });
    await f.send("other");
    const second = await f.send("reader", { kind: "decision", obligation: "acknowledge", supersedes: [first.messageId] });
    const note = await f.send("reader");
    await f.service.readInbox({ ...owner(f.reader), messageId: note.messageId });
    await f.send("reader", { kind: "question", obligation: "reply" });
    const manifest = path.join(f.root, "indexes", "v2", "cache.json");
    assert.ok((await stat(manifest)).isFile(), "the cache lives in indexes/v2");
    let service = f.service;
    if (path_ === "cold") await rm(manifest);
    if (path_ === "rebuilt") {
      const value = JSON.parse(await readFile(manifest, "utf8"));
      await writeFile(manifest, `${JSON.stringify({ ...value, journalGeneration: "0000000000000001" })}\n`);
    }
    if (path_ === "unavailable") {
      await rm(manifest);
      service = await f.reopen({ failAt: async point => { if (point === "before-index-manifest") throw new Error("no cache"); } });
    }
    const page = await service.listInbox({ ...owner(f.reader), limit: 20 });
    const exact = await service.readInbox({ ...owner(f.reader), messageId: first.messageId });
    answers[path_] = { page: page.items.map(item => [item.message.messageId, item.message.decisionStatus?.state ?? null,
      item.receipt.state]), cursor: page.nextCursor, exact: [exact[0].message.decisionStatus.state, exact[0].receipt.state] };
    assert.deepEqual(answers[path_].exact, ["superseded", "retrieved"], path_);
    // Each path took its own way: a rebuild publishes a current cache, an unavailable one none.
    if (path_ === "unavailable") await assert.rejects(stat(manifest), { code: "ENOENT" });
    if (path_ === "rebuilt") assert.notEqual(JSON.parse(await readFile(manifest, "utf8")).journalGeneration, "0000000000000001");
    assert.equal(page.items.some(item => item.message.messageId === first.messageId), false, `${path_}: a replaced decision is listed`);
    assert.equal(page.items.some(item => item.message.messageId === second.messageId), true, path_);
  }
  for (const path_ of ["cold", "rebuilt", "unavailable"]) assert.deepEqual(answers[path_], answers.warm, path_);
});

test("a cursor continues after the message it names has been acknowledged", async t => {
  const f = await fixture(t);
  const sent = [];
  for (let index = 0; index < 6; index++) sent.push(await f.send("reader", { kind: "decision", obligation: "acknowledge" }));
  const first = await f.service.listInbox({ ...owner(f.reader), limit: 2 });
  assert.equal(first.nextCursor, sent[4].messageId);
  await f.service.readInbox({ ...owner(f.reader), messageId: sent[4].messageId });
  await f.service.acknowledgeMessage({ ...owner(f.reader), messageId: sent[4].messageId });
  const next = await f.service.listInbox({ ...owner(f.reader), limit: 2, cursor: first.nextCursor });
  assert.deepEqual(next.items.map(item => item.message.messageId), [sent[3].messageId, sent[2].messageId]);
  // A cursor that names a message for someone else is refused, as before.
  const elsewhere = await f.send("other");
  await assert.rejects(f.service.listInbox({ ...owner(f.reader), limit: 2, cursor: elsewhere.messageId }),
    /cursor is not in this message list/);
});

test("indexes/v1, as an older ACC keeps it, is neither read nor written", async t => {
  const f = await fixture(t);
  const legacy = path.join(f.root, "indexes", "v1", "cache.json");
  await rm(legacy, { force: true });
  await f.send("reader");
  await f.service.listInbox({ ...owner(f.reader), limit: 5 });
  await assert.rejects(stat(legacy), { code: "ENOENT" });
});
