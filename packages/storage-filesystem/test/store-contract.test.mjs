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
  ...overrides,
});

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
