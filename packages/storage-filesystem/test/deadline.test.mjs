import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createId, EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { readOpenJournals } from "../src/journal.mjs";
import { openFilesystemStore } from "../src/store.mjs";

const WORKSPACE = "workspace_deadline";
const BUDGET_MS = 1_000;
const participant = displayName => ({ schemaVersion: SCHEMA_VERSION,
  participantId: "participant_a", workspaceId: WORKSPACE, displayName,
  kind: "agent", createdAt: "2026-09-07T00:00:00.000Z" });
const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const expired = error => error?.code === EXIT.CONFLICT && /deadline/.test(error.message);
const settle = promise => promise.then(value => ({ value }), error => ({ error }));

async function crossDeadline(deadlineAt) {
  while (Date.now() <= deadlineAt) await delay(Math.max(1, deadlineAt - Date.now() + 1));
}

async function fixture(t, failAt) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-store-deadline-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, workspaceId: WORKSPACE,
    clock: { now: () => new Date().toISOString() }, ids: { next: kind => createId(kind) } };
  // Prepare the directory before starting this operation's explicit budget.
  const observer = await openFilesystemStore(options);
  const deadlineAt = Date.now() + BUDGET_MS;
  const store = await openFilesystemStore({ ...options, deadlineAt,
    failAt: where => failAt?.(where, deadlineAt) });
  const inspect = async current => ({ snapshot: await current.snapshot(WORKSPACE),
    events: await current.eventsSince(WORKSPACE, null, 50) });
  return { store, observer, deadlineAt, inspect,
    reopen: () => openFilesystemStore(options) };
}

function stageParticipant(tx) {
  tx.put("participant", "participant_a", participant("Committed"));
  tx.append({ schemaVersion: SCHEMA_VERSION, eventId: createId("event"),
    workspaceId: WORKSPACE, actorSessionId: "session_a", type: "session.opened",
    occurredAt: "2026-09-07T00:00:00.000Z", payload: {} });
}

test("a store deadline cannot be extended by a transaction whose callback finishes late", async t => {
  const f = await fixture(t);
  const before = await f.inspect(f.observer);
  await assert.rejects(f.store.transaction(async tx => {
    stageParticipant(tx);
    await crossDeadline(f.deadlineAt);
  }, { kinds: ["participant"], deadlineAt: f.deadlineAt + 60_000 }), expired);
  assert.deepEqual(await f.inspect(await f.reopen()), before);
});

for (const operation of ["transaction", "put", "update", "delete"]) {
  const label = operation === "transaction" ? operation : `ephemeral ${operation}`;
  test(`a store deadline stops ${label} waiting for the writer`, async t => {
    const f = await fixture(t);
    await f.observer.ephemeral.put("participant", "participant_a", participant("Original"));
    const entered = gate(), release = gate();
    const holder = f.observer.ephemeral.update("participant", "participant_a", async () => {
      entered.release();
      await release.promise;
      return null;
    });
    await entered.promise;
    let callbackEntered = false;
    const update = () => { callbackEntered = true; return participant("Late"); };
    const invoke = {
      transaction: () => f.store.transaction(tx => { callbackEntered = true; stageParticipant(tx); },
        { kinds: ["participant"] }),
      put: () => f.store.ephemeral.put("participant", "participant_a", participant("Late")),
      update: () => f.store.ephemeral.update("participant", "participant_a", update),
      delete: () => f.store.ephemeral.delete("participant", "participant_a", () => {
        callbackEntered = true; return true;
      }),
    }[operation];
    const waiting = settle(invoke());
    let atDeadline;
    try {
      await crossDeadline(f.deadlineAt);
      atDeadline = await Promise.race([waiting, delay(500).then(() => null)]);
    } finally {
      release.release();
      await holder;
    }
    const result = await waiting;
    assert.notEqual(atDeadline, null, "the expired caller kept waiting for another writer");
    assert.ok(expired(result.error), "the expired writer committed after acquiring the lock");
    assert.equal(callbackEntered, false);
    assert.deepEqual(await f.observer.ephemeral.get("participant", "participant_a"),
      participant("Original"));
    assert.deepEqual((await f.observer.eventsSince(WORKSPACE, null, 50)).events, []);
  });
}

test("a store deadline cancels an ephemeral update after its updater returns", async t => {
  const f = await fixture(t);
  await f.observer.ephemeral.put("participant", "participant_a", participant("Original"));
  await assert.rejects(f.store.ephemeral.update("participant", "participant_a", async current => {
    await crossDeadline(f.deadlineAt);
    return { ...current, displayName: "Late" };
  }), expired);
  assert.deepEqual(await f.observer.ephemeral.get("participant", "participant_a"),
    participant("Original"));
});

test("a store deadline cancels deletion after an asynchronous guard expires", async t => {
  const f = await fixture(t);
  await f.observer.ephemeral.put("participant", "participant_a", participant("Original"));
  await assert.rejects(f.store.ephemeral.delete("participant", "participant_a", async () => {
    await crossDeadline(f.deadlineAt);
    return true;
  }), expired);
  assert.deepEqual(await f.observer.ephemeral.get("participant", "participant_a"), participant("Original"));
});

test("a prepared journal cannot become committed after its deadline", async t => {
  let prepared = false;
  const f = await fixture(t, async (where, deadlineAt) => {
    if (where !== "after-journal-prepared") return;
    prepared = true;
    await crossDeadline(deadlineAt);
  });
  const before = await f.inspect(f.observer);
  // Explicit transaction deadlines already exist; preparation must not turn
  // that existing limit into permission to activate a journal after expiry.
  await assert.rejects(f.store.transaction(stageParticipant,
    { kinds: ["participant"], deadlineAt: f.deadlineAt }), expired);
  assert.equal(prepared, true);
  assert.deepEqual(await readOpenJournals(f.store.paths, f.store.root), []);
  assert.deepEqual(await f.inspect(await f.reopen()), before);
});

for (const outcome of ["complete", "recover"]) {
  test(`an activated journal can ${outcome} after the store deadline`, async t => {
    const crash = new Error("fixture stopped after activation");
    let activated = false;
    const f = await fixture(t, async (where, deadlineAt) => {
      if (where !== "after-journal") return;
      activated = true;
      await crossDeadline(deadlineAt);
      if (outcome === "recover") throw crash;
    });
    const committed = f.store.transaction(stageParticipant,
      { kinds: ["participant"], deadlineAt: f.deadlineAt });
    if (outcome === "recover") await assert.rejects(committed, error => error === crash);
    else await committed;
    assert.equal(activated, true);
    const reopened = await f.reopen();
    assert.deepEqual((await reopened.snapshot(WORKSPACE)).participants, [participant("Committed")]);
    const { events } = await reopened.eventsSince(WORKSPACE, null, 50);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "session.opened");
    assert.deepEqual(await readOpenJournals(reopened.paths, reopened.root), []);
  });
}
