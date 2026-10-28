import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { openFilesystemStore } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { measureTransactionIO } from "../../../tests/helpers/store-io-probe.mjs";

// #307: a transaction found the next event sequence before its callback ran, by listing
// the whole event log, also when it only read. The sequence is now found when the
// transaction commits an event or a journal.
const WORKSPACE = "workspace_sequence";
const NOW = "2026-10-28T12:00:00.000Z";
const intent = { schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE, sessionId: "session_a",
  summary: "working", mode: "edit", resourceHints: [], state: "active", updatedAt: NOW };
const event = index => ({ schemaVersion: SCHEMA_VERSION, eventId: `event_${index}`, workspaceId: WORKSPACE,
  actorSessionId: "session_a", type: "intent.published", occurredAt: NOW, payload: { mode: "edit", state: "active" } });

async function store(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-sequence-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = await openFilesystemStore({ root, clock: createFakeClock(NOW), ids: createFakeIds(),
    workspaceId: WORKSPACE });
  let appended = 0;
  const append = count => opened.transaction(tx => {
    const events = [];
    for (let i = 0; i < count; i++) events.push(tx.append(event(appended++)));
    return events;
  }, { kinds: [] });
  return { root, store: opened, append };
}

test("a read-only transaction never lists the event log", async t => {
  const { root, store: opened, append } = await store(t);
  for (let i = 0; i < 40; i++) await append(1);
  await opened.transaction(tx => tx.put("intent", "session_a", intent), { kinds: ["intent"] });
  const measured = await measureTransactionIO(root, () => opened.transaction(tx => tx.get("intent", "session_a"),
    { kinds: ["intent"] }));
  assert.equal(measured.result.summary, "working");
  assert.equal(measured.io["events/readdir"] ?? 0, 0, JSON.stringify(measured.io));
});

test("a transaction's events take the next sequences, in the order appended, when it commits", async t => {
  const { store: opened, append } = await store(t);
  const first = await append(2), second = await append(3);
  // The events tx.append returned carry the sequence the commit gave them.
  assert.deepEqual([...first, ...second].map(item => Number(item.sequence)), [1, 2, 3, 4, 5]);
  const page = await opened.eventsSince(WORKSPACE, null, 50);
  assert.deepEqual(page.events.map(item => item.eventId), ["event_0", "event_1", "event_2", "event_3", "event_4"]);
  assert.deepEqual(page.events.map(item => item.sequence), [...first, ...second].map(item => item.sequence));
});

test("a callback that fails commits no event and uses no sequence", async t => {
  const { store: opened, append } = await store(t);
  await append(1);
  const boom = new Error("callback failed");
  await assert.rejects(opened.transaction(tx => { tx.append(event(90)); throw boom; }, { kinds: [] }), boom);
  const [next] = await append(1);
  assert.equal(Number(next.sequence), 2);
  assert.deepEqual((await opened.eventsSince(WORKSPACE, null, 50)).events.map(item => item.eventId),
    ["event_0", "event_1"]);
});

test("an exhausted sequence refuses a write and leaves reads working", async t => {
  const { store: opened, append } = await store(t);
  await append(1);
  await opened.transaction(tx => tx.put("intent", "session_a", intent), { kinds: ["intent"] });
  await writeFile(path.join(opened.paths.events, `${"9".repeat(16)}.json`),
    `${JSON.stringify({ sequence: "9".repeat(16) })}\n`);
  await assert.rejects(append(1), error => error.code === EXIT.DATA && /exhausted/.test(error.message));
  assert.equal((await opened.transaction(tx => tx.get("intent", "session_a"), { kinds: ["intent"] })).summary, "working");
});

test("an event the callback appends is refused there when its shape is wrong", async t => {
  const { store: opened } = await store(t);
  let reached = false;
  await assert.rejects(opened.transaction(tx => {
    tx.append({ ...event(1), type: "not an event type" });
    reached = true;
  }, { kinds: [] }), error => error.code === EXIT.DATA);
  assert.equal(reached, false, "a malformed event fails where it is appended, not at commit");
});
