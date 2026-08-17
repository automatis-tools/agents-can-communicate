import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { diagnoseFilesystemStore, repairFilesystemStore } from "../src/recovery.mjs";
import { openFilesystemStore } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";

async function tempRoot(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-recovery-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const open = (root, failAt) => openFilesystemStore({ root, clock: createFakeClock(NOW),
  ids: createFakeIds(), workspaceId: WORKSPACE, failAt });

const workspaceRecord = () => ({ schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE,
  displayName: "Example", source: "directory", roots: ["/tmp/example"], createdAt: NOW });

const eventRecord = id => ({ schemaVersion: SCHEMA_VERSION, eventId: id,
  workspaceId: WORKSPACE, actorSessionId: "session_a", type: "workspace.materialised",
  occurredAt: NOW, payload: {} });

function crashAt(marker) {
  const failure = Object.assign(new Error(`synthetic crash ${marker}`), { marker });
  return { failure, failAt: async where => { if (where === marker) throw failure; } };
}

async function writeTransaction(store) {
  return store.transaction(async tx => {
    tx.append(eventRecord("event_created"));
    tx.put("workspace", WORKSPACE, workspaceRecord());
  });
}

test("a crash after the journal but before publication publishes nothing", async t => {
  const root = await tempRoot(t);
  const { failure, failAt } = crashAt("after-journal");
  const store = await open(root, failAt);

  await assert.rejects(writeTransaction(store), failure);

  assert.deepEqual((await readdir(path.join(root, "events"))), []);
  assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events, []);
  assert.equal((await store.snapshot(WORKSPACE)).workspace, null);
  assert.equal((await readdir(path.join(root, "journal"))).length, 1);
});

test("a crash between the event and the state record stays invisible to readers", async t => {
  const root = await tempRoot(t);
  const { failure, failAt } = crashAt("after:events/0000000000000001.json");
  const store = await open(root, failAt);

  await assert.rejects(writeTransaction(store), failure);

  // The event file is on disk, but the transaction is not complete, so no
  // reader may see it. The open journal is what makes that decidable.
  assert.deepEqual(await readdir(path.join(root, "events")), ["0000000000000001.json"]);
  assert.deepEqual((await store.eventsSince(WORKSPACE, null, 10)).events, []);
  assert.equal((await store.snapshot(WORKSPACE)).workspace, null);
});

test("reopening the store completes a journalled transaction exactly", async t => {
  const root = await tempRoot(t);
  const { failure, failAt } = crashAt("after:events/0000000000000001.json");
  await assert.rejects(writeTransaction(await open(root, failAt)), failure);

  const reopened = await open(root);

  const page = await reopened.eventsSince(WORKSPACE, null, 10);
  assert.deepEqual(page.events.map(event => event.eventId), ["event_created"]);
  assert.equal((await reopened.snapshot(WORKSPACE)).workspace.displayName, "Example");
  assert.deepEqual(await readdir(path.join(root, "journal")), []);
});

test("repair completes a pending transaction and is idempotent", async t => {
  const root = await tempRoot(t);
  const { failure, failAt } = crashAt("after:events/0000000000000001.json");
  await assert.rejects(writeTransaction(await open(root, failAt)), failure);

  const diagnosis = await diagnoseFilesystemStore({ root });
  assert.equal(diagnosis.repaired.length, 1, "a pending transaction was not reported");
  assert.equal(diagnosis.healthy, true);

  const first = await repairFilesystemStore({ root, clock: createFakeClock(NOW) });
  assert.equal(first.repaired.length, 1);

  const listing = await readdir(path.join(root, "state", "workspace"));
  const second = await repairFilesystemStore({ root, clock: createFakeClock(NOW) });

  assert.deepEqual(second.repaired, [], "repair was not idempotent");
  assert.equal(second.healthy, true);
  assert.deepEqual(await readdir(path.join(root, "state", "workspace")), listing);
});

test("diagnosis is read-only", async t => {
  const root = await tempRoot(t);
  const { failure, failAt } = crashAt("after:events/0000000000000001.json");
  await assert.rejects(writeTransaction(await open(root, failAt)), failure);
  const before = await readdir(path.join(root, "journal"));

  await diagnoseFilesystemStore({ root });

  assert.deepEqual(await readdir(path.join(root, "journal")), before);
});

test("repair fails closed on a corrupt state record", async t => {
  const root = await tempRoot(t);
  const store = await open(root);
  await writeTransaction(store);
  await writeFile(path.join(root, "state", "workspace", `${WORKSPACE}.json`), "{not-json");

  const diagnosis = await diagnoseFilesystemStore({ root });
  const repaired = await repairFilesystemStore({ root, clock: createFakeClock(NOW) });

  assert.equal(diagnosis.healthy, false);
  assert.equal(diagnosis.corrupt.length, 1);
  assert.deepEqual(repaired.repaired, [], "repair acted on an unreadable store");
  assert.equal(repaired.healthy, false);
});

test("repair fails closed on a store with no identity", async t => {
  const root = await tempRoot(t);
  await writeTransaction(await open(root));
  await rm(path.join(root, "protocol.json"));

  const repaired = await repairFilesystemStore({ root, clock: createFakeClock(NOW) });

  assert.equal(repaired.healthy, false);
  assert.equal(repaired.blocked.length, 1);
});

test("opening a store that belongs to another workspace is refused", async t => {
  const root = await tempRoot(t);
  await open(root);

  await assert.rejects(openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: "workspace_b" }),
  error => error.code === EXIT.DATA && error.message.includes("different workspace"));
});

test("an unknown store version blocks both diagnosis and repair", async t => {
  const root = await tempRoot(t);
  await open(root);
  await writeFile(path.join(root, "protocol.json"),
    `${JSON.stringify({ storeVersion: 99, workspaceId: WORKSPACE })}\n`);

  const diagnosis = await diagnoseFilesystemStore({ root });
  const repaired = await repairFilesystemStore({ root, clock: createFakeClock(NOW) });

  assert.equal(diagnosis.healthy, false);
  assert.deepEqual(diagnosis.blocked, [path.join(root, "protocol.json")]);
  assert.equal(repaired.healthy, false);
});
