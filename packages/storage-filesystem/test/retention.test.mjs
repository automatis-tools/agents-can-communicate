import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import * as atomicJson from "../src/atomic-json.mjs";
import { readOpenJournals } from "../src/journal.mjs";
import { openFilesystemStore } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-retention-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = createFakeIds();
  const store = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids, workspaceId: WORKSPACE });
  return { ids, root, store };
}

const workspaceRecord = () => ({ schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE,
  displayName: "Example", source: "directory", roots: ["/tmp/example"], createdAt: NOW });

const binding = () => ({ schemaVersion: SCHEMA_VERSION, sessionId: "session_a",
  generation: "generation_a", adapterId: "codex", clientVersion: "1.2.3",
  availableModes: ["nextTurn"], livePolicy: "actionable", opaqueEndpointRef: "socket_a",
  leaseUntil: NOW, retiredAt: null });

async function writeEphemeralMarker(root, sequence, state) {
  const directory = path.join(root, "retained", "ephemeral", "deliveryBinding", "session_a");
  await mkdir(directory, { recursive: true });
  const record = { retentionVersion: 1, area: "ephemeral", kind: "deliveryBinding",
    id: "session_a", sequence, state };
  await writeFile(path.join(directory, `${sequence}.json`), `${JSON.stringify(record)}\n`);
}

test("retention cannot unlink outside after its validated parent is replaced", async t => {
  assert.equal(typeof atomicJson.retainFile, "function");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-retain-race-")));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "acc-outside-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })]));
  const managed = path.join(root, "managed");
  const retired = path.join(root, "retired");
  const target = path.join(managed, "sentinel.json");
  const outsideSentinel = path.join(outside, "sentinel.json");
  await mkdir(managed);
  await writeFile(target, "inside\n");
  await writeFile(outsideSentinel, "outside\n");

  await atomicJson.retainFile(target, { root, afterValidation: async () => {
    await rename(managed, retired);
    await symlink(outside, managed);
  } });

  assert.equal(await readFile(outsideSentinel, "utf8"), "outside\n");
  assert.equal(await readFile(path.join(retired, "sentinel.json"), "utf8"), "inside\n");
});

test("journal retirement is logical and retains the decided transaction", async t => {
  const { root, store } = await fixture(t);
  await store.transaction(async tx => { tx.put("workspace", WORKSPACE, workspaceRecord()); });

  assert.deepEqual(await readOpenJournals(store.paths, root), []);
  assert.deepEqual((await readdir(store.paths.journal)).filter(name => name.endsWith(".json")),
    ["transaction_000001.json"]);
});

test("journalled state removal hides but retains the removed generation", async t => {
  const { root, store } = await fixture(t);
  await store.transaction(async tx => { tx.put("workspace", WORKSPACE, workspaceRecord()); });
  const stateFile = path.join(store.paths.state, "workspace", `${WORKSPACE}.json`);
  const before = await readFile(stateFile, "utf8");
  const generation = await store.transaction(async tx => tx.generationOf("workspace", WORKSPACE));

  await store.transaction(async tx => { tx.remove("workspace", WORKSPACE, generation); });

  assert.equal((await store.snapshot(WORKSPACE)).workspace, null);
  assert.equal(await readFile(stateFile, "utf8"), before);
  assert.deepEqual(await readOpenJournals(store.paths, root), []);

  await store.transaction(async tx => { tx.put("workspace", WORKSPACE, workspaceRecord()); });
  assert.equal((await store.snapshot(WORKSPACE)).workspace.displayName, "Example");
});

test("recovery completes a journalled logical removal without unlinking state", async t => {
  const { ids, root, store } = await fixture(t);
  await store.transaction(async tx => { tx.put("workspace", WORKSPACE, workspaceRecord()); });
  const stateFile = path.join(store.paths.state, "workspace", `${WORKSPACE}.json`);
  const before = await readFile(stateFile, "utf8");
  const generation = await store.transaction(async tx => tx.generationOf("workspace", WORKSPACE));
  const crash = new Error("synthetic crash after deletion marker");
  const reopenedForRemoval = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids, workspaceId: WORKSPACE,
    failAt: async where => {
      if (where.startsWith("after:retained/state/")) throw crash;
    } });

  await assert.rejects(reopenedForRemoval.transaction(async tx => {
    tx.remove("workspace", WORKSPACE, generation);
  }), crash);

  const recovered = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids, workspaceId: WORKSPACE });
  assert.equal((await recovered.snapshot(WORKSPACE)).workspace, null);
  assert.equal(await readFile(stateFile, "utf8"), before);
  assert.deepEqual(await readOpenJournals(recovered.paths, root), []);
});

test("ephemeral deletion hides but retains the last published record", async t => {
  const { root, store } = await fixture(t);
  await store.ephemeral.put("deliveryBinding", "session_a", binding());
  const file = path.join(store.paths.ephemeral, "deliveryBinding", "session_a.json");
  const before = await readFile(file, "utf8");

  await store.ephemeral.delete("deliveryBinding", "session_a");

  assert.equal(await store.ephemeral.get("deliveryBinding", "session_a"), null);
  assert.deepEqual(await store.ephemeral.list("deliveryBinding"), []);
  assert.equal(await readFile(file, "utf8"), before);

  const reopened = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE });
  assert.equal(await reopened.ephemeral.get("deliveryBinding", "session_a"), null);
  await reopened.ephemeral.put("deliveryBinding", "session_a", binding());
  assert.deepEqual(await reopened.ephemeral.get("deliveryBinding", "session_a"), binding());
});

test("an unknown ephemeral marker state fails closed instead of resurrecting a deletion",
  async t => {
    const { root, store } = await fixture(t);
    await store.ephemeral.put("deliveryBinding", "session_a", binding());
    await store.ephemeral.delete("deliveryBinding", "session_a");
    await writeEphemeralMarker(root, "0000000000000003", "unknown");

    await assert.rejects(store.ephemeral.get("deliveryBinding", "session_a"),
      error => error.code === 4 && /ephemeral retention marker/.test(error.message));
  });

test("a non-numeric ephemeral marker sequence fails closed before selection", async t => {
  const { root, store } = await fixture(t);
  await store.ephemeral.put("deliveryBinding", "session_a", binding());
  await writeEphemeralMarker(root, "banana", "deleted");

  await assert.rejects(store.ephemeral.get("deliveryBinding", "session_a"),
    error => error.code === 4 && /ephemeral retention marker/.test(error.message));
});

test("ephemeral markers are selected by numeric sequence rather than filename order", async t => {
  const { root, store } = await fixture(t);
  await store.ephemeral.put("deliveryBinding", "session_a", binding());
  await writeEphemeralMarker(root, "9999999999999999", "deleted");
  await writeEphemeralMarker(root, "10000000000000000", "present");

  assert.deepEqual(await store.ephemeral.get("deliveryBinding", "session_a"), binding());
});
