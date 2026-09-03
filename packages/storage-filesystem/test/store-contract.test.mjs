import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";
import { runStoreContract } from "../../core/test/service-contract.test.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";
import { openFilesystemStore } from "../src/store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const roots = [];

// The runner owns the lifecycle of each store, so roots are collected and
// removed once rather than wrapped per test.
after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

async function filesystemStore() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acc-store-")));
  roots.push(root);
  return openFilesystemStore({
    root,
    clock: createFakeClock(NOW),
    ids: createFakeIds(),
    workspaceId: "workspace_a",
  });
}

const memoryStore = async () => createMemoryStore({
  clock: createFakeClock(NOW), ids: createFakeIds(), workspaceId: "workspace_a",
});

runStoreContract("filesystem", filesystemStore);

const SNAPSHOT_KEYS = ["claims", "intents", "messages", "participants", "receipts",
  "sessions", "workspace"];
const binding = (overrides = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: "session_a", generation: "generation_a", adapterId: "codex",
  clientVersion: "1.2.3", availableModes: ["nextTurn", "livePush"],
  livePolicy: "actionable", opaqueEndpointRef: "socket_a", leaseUntil: NOW,
  retiredAt: null,
  ...overrides,
});

const workspaceRecord = (overrides = {}) => ({ schemaVersion: SCHEMA_VERSION,
  workspaceId: "workspace_a", displayName: "Example", source: "directory",
  roots: ["/tmp/example"], createdAt: NOW, ...overrides });

const eventRecord = (overrides = {}) => ({ schemaVersion: SCHEMA_VERSION,
  eventId: "event_a", workspaceId: "workspace_a", actorSessionId: "session_a",
  type: "session.opened", occurredAt: NOW, payload: {}, ...overrides });

for (const [name, makeStore] of [["memory", memoryStore], ["filesystem", filesystemStore]]) {
  test(`${name}: snapshots expose only v0.2 durable collections`, async () => {
    const store = await makeStore();
    assert.deepEqual(Object.keys(await store.snapshot("workspace_a")).sort(), SNAPSHOT_KEYS);
  });

  test(`${name}: ephemeral put and update validate delivery bindings`, async () => {
    const store = await makeStore();
    await assert.rejects(() => store.ephemeral.put("deliveryBinding", "session_a",
      binding({ schemaVersion: 2 })), error => error.code === EXIT.DATA);
    await store.ephemeral.put("deliveryBinding", "session_a", binding());
    await assert.rejects(() => store.ephemeral.update("deliveryBinding", "session_a",
      current => ({ ...current, livePolicy: "implicit" })),
    error => error.code === EXIT.DATA && /livePolicy/.test(error.message));
    assert.deepEqual(await store.ephemeral.list("deliveryBinding"), [binding()]);
  });
}

test("memory: ephemeral list refuses a binding corrupted after put", async () => {
  const store = await memoryStore();
  await store.ephemeral.put("deliveryBinding", "session_a", binding());
  const stored = await store.ephemeral.get("deliveryBinding", "session_a");
  stored.schemaVersion = 2;

  await assert.rejects(() => store.ephemeral.list("deliveryBinding"),
    error => error.code === EXIT.DATA && /schemaVersion/.test(error.message));
});

test("memory: snapshot refuses a committed durable record corrupted after put", async () => {
  const store = await memoryStore();
  const record = workspaceRecord();
  await store.transaction(async tx => tx.put("workspace", "workspace_a", record));
  record.schemaVersion = 2;

  await assert.rejects(() => store.snapshot("workspace_a"),
    error => error.code === EXIT.DATA && /schemaVersion/.test(error.message));
});

test("memory: eventsSince refuses an old event before workspace filtering", async () => {
  const store = await memoryStore();
  let committed;
  await store.transaction(async tx => {
    committed = tx.append(eventRecord({ workspaceId: "workspace_b" }));
  });
  committed.schemaVersion = 2;

  await assert.rejects(() => store.eventsSince("workspace_a", null, 10),
    error => error.code === EXIT.DATA && /schemaVersion/.test(error.message));
});

test("memory: eventsSince refuses a removed event type", async () => {
  const store = await memoryStore();
  let committed;
  await store.transaction(async tx => { committed = tx.append(eventRecord()); });
  committed.type = "task.created";

  await assert.rejects(() => store.eventsSince("workspace_a", null, 10),
    error => error.code === EXIT.DATA && /type/.test(error.message));
});

test("filesystem: old durable state is refused without being rewritten or removed", async () => {
  const store = await filesystemStore();
  const directory = join(store.paths.state, "workspace");
  const file = join(directory, "workspace_a.json");
  await mkdir(directory);
  const oldEnvelope = JSON.stringify({ kind: "workspace", id: "workspace_a",
    generation: "generation_old", record: { schemaVersion: 2,
      workspaceId: "workspace_a", displayName: "Old", source: "directory",
      roots: ["/tmp/old"], createdAt: NOW } });
  await writeFile(file, oldEnvelope);

  await assert.rejects(() => store.snapshot("workspace_a"),
    error => error.code === EXIT.DATA && error.message.includes("schemaVersion"));
  assert.equal(await readFile(file, "utf8"), oldEnvelope);
});

test("filesystem: ephemeral list validates hand-written delivery bindings", async () => {
  const store = await filesystemStore();
  const directory = join(store.paths.ephemeral, "deliveryBinding");
  const file = join(directory, "session_a.json");
  await mkdir(directory);
  await writeFile(file, JSON.stringify(binding({ schemaVersion: 2 })));

  await assert.rejects(() => store.ephemeral.list("deliveryBinding"),
    error => error.code === EXIT.DATA && /schemaVersion/.test(error.message));
});

for (const [name, overrides, message] of [
  ["old schema", { schemaVersion: 2, workspaceId: "workspace_b" }, /schemaVersion/],
  ["removed type", { type: "task.created" }, /type/],
]) {
  test(`filesystem: eventsSince refuses ${name} events`, async () => {
    const store = await filesystemStore();
    const sequence = "0000000000000001";
    await writeFile(join(store.paths.events, `${sequence}.json`),
      JSON.stringify({ ...eventRecord(overrides), sequence }));

    await assert.rejects(() => store.eventsSince("workspace_a", null, 10),
      error => error.code === EXIT.DATA && message.test(error.message));
  });
}
