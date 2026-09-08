import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";
import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const workspaceId = "workspace_message_pages";
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

async function fixture() {
  const clock = createFakeClock("2026-08-01T12:00:00.000Z"), ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId });
  const service = createCoordinationService({ clock, ids, store });
  const open = participantId => service.openSession({ workspaceId, participantId,
    harness: "fixture", heartbeatCadenceMs: 30_000 });
  const sender = await open("sender"), reader = await open("reader"), other = await open("other");
  const send = (subject, extra = {}) => service.sendMessage({ ...owner(sender),
    clientMessageId: `client_${subject}`, kind: "note", obligation: "none",
    subject, body: "BODY_SENTINEL", toParticipantIds: ["reader"], ...extra });
  return { clock, store, service, sender, reader, other, send };
}

test("inbox discovery bounds Unicode summaries without returning nested payloads or retrieving mail", async () => {
  const f = await fixture();
  for (let i = 0; i < 40; i += 1) await f.send(`note-${i}`, {
    subject: "🧭".repeat(200), body: "🧭".repeat(1_500),
    artifacts: [{ kind: "file", uri: "file:old.mjs", description: "ARTIFACT_SENTINEL" }],
  });
  const before = await f.store.snapshot(workspaceId);
  const events = await f.store.eventsSince(workspaceId, null, 500);
  const page = await f.service.listInbox({ ...owner(f.reader), limit: 500 });
  const encoded = JSON.stringify(page, null, 2);
  assert.ok(Buffer.byteLength(encoded) <= 12_000, "summary page exceeded its byte ceiling");
  assert.ok(page.items.length > 0 && page.items.length < 40 && page.nextCursor);
  assert.doesNotMatch(encoded, /BODY_SENTINEL|ARTIFACT_SENTINEL|"body":|"artifacts":/);
  for (const item of page.items) {
    assert.ok(Buffer.byteLength(item.message.subject) <= 160);
    assert.equal(item.message.subject.isWellFormed(), true);
    assert.equal(item.message.bodyBytes, 6_000);
    assert.equal(item.message.artifactCount, 1);
    assert.equal(item.message.trust, "untrusted peer content");
  }
  assert.deepEqual(await f.store.snapshot(workspaceId), before);
  assert.deepEqual(await f.store.eventsSince(workspaceId, null, 500), events);
});

test("a read or resolved anchor cannot shift a later page, including same-timestamp messages", async () => {
  const f = await fixture();
  const messages = [];
  for (let i = 1; i <= 6; i += 1) messages.push(await f.send(`note-${i}`));
  const first = await f.service.listInbox({ ...owner(f.reader), limit: 2 });
  assert.deepEqual(first.items.map(item => item.message.subject), ["note-6", "note-5"]);
  await f.service.readInbox({ ...owner(f.reader), messageId: first.nextCursor });
  await f.service.acknowledgeMessage({ ...owner(f.reader), messageId: messages[5].messageId });
  const next = await f.service.listInbox({ ...owner(f.reader), cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(next.items.map(item => item.message.subject), ["note-4", "note-3"]);
  const last = await f.service.listInbox({ ...owner(f.reader), cursor: next.nextCursor, limit: 2 });
  assert.deepEqual(last.items.map(item => item.message.subject), ["note-2", "note-1"]);
  assert.equal(last.nextCursor, null);
});

test("the history byte ceiling includes its scope and view framing", async () => {
  const f = await fixture();
  for (let i = 0; i < 40; i += 1) await f.send(`note-${i}`, { subject: "xx" });
  const defaultPage = await f.service.sync({ scope: "history" });
  assert.equal(defaultPage.items.length, 20, "default count must apply before the byte ceiling");
  const page = await f.service.sync({ scope: "history", limit: 500 });
  assert.ok(page.items.length > 0 && page.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= 12_000,
    "history framing pushed a full summary page over its byte ceiling");
});

test("history filters before paging and recovers a complete historical handoff without receipts changing", async () => {
  const f = await fixture();
  const old = await f.service.finishSession({ ...owner(f.sender), clientMessageId: "done",
    goal: "Earlier work", completed: ["HANDOFF_SENTINEL"], toParticipantId: "reader" });
  f.clock.advance(1_000);
  await f.service.sendMessage({ ...owner(f.other), clientMessageId: "newer",
    kind: "note", obligation: "none", subject: "Newer note", body: "BODY_SENTINEL",
    toParticipantIds: ["reader"] });
  const before = await f.store.snapshot(workspaceId);
  const page = await f.service.sync({ scope: "history", kind: "handoff", limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].messageId, old.message.messageId);
  assert.doesNotMatch(JSON.stringify(page), /HANDOFF_SENTINEL|BODY_SENTINEL|"snapshot":|"events":/);
  const exact = await f.service.sync({ scope: "history", messageId: old.message.messageId });
  assert.equal(exact.view, "message");
  assert.deepEqual(exact.items, [old.message]);
  assert.deepEqual(await f.store.snapshot(workspaceId), before);
});

test("listing rejects foreign cursors and stale ownership without disclosing or changing mail", async () => {
  const f = await fixture();
  await f.send("own");
  const foreign = await f.send("foreign", { toParticipantIds: ["other"] });
  const before = await f.store.snapshot(workspaceId);
  await assert.rejects(f.service.listInbox({ ...owner(f.reader), cursor: foreign.messageId }),
    error => error.code === EXIT.USAGE);
  await assert.rejects(f.service.listInbox({ ...owner(f.reader), generation: "generation_stale" }),
    error => error.code === EXIT.CONFLICT);
  assert.deepEqual(await f.store.snapshot(workspaceId), before);
});

test("invalid list controls and scope mismatches are errors rather than unbounded reads", async () => {
  const f = await fixture();
  const message = await f.send("own");
  for (const input of [{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 501 },
    { limit: "2" }, { limit: null }, { cursor: "" }, { cursor: "message_missing" }]) {
    await assert.rejects(f.service.sync({ scope: "history", ...input }),
      error => error.code === EXIT.USAGE);
    await assert.rejects(f.service.listInbox({ ...owner(f.reader), ...input }),
      error => error.code === EXIT.USAGE);
  }
  for (const input of [{ scope: "history", kind: "invented" },
    { scope: "history", messageId: message.messageId, limit: 1 },
    { scope: "history", messageId: message.messageId, cursor: message.messageId },
    { scope: "history", messageId: message.messageId, kind: "note" },
    { scope: "full", messageId: message.messageId }, { kind: "note" }]) {
    await assert.rejects(f.service.sync(input), error => error.code === EXIT.USAGE);
  }
});
