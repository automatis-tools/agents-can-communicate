import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { reclaimGenerations } from "../src/managed-runtime/activation.mjs";
import { writePin } from "../src/managed-runtime/pins.mjs";

test("an unreferenced generation is removed and a pinned one is kept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-"));
  for (const name of ["0.4.0-a", "0.4.2-b", "0.4.4-c"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await writePin({ root, harnessSessionId: "h1",
    runtimeRoot: path.join(root, "generations", "0.4.2-b"), version: "0.4.2",
    storeVersion: 6, clientPid: process.pid });
  await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.4-c"),
    pidIsAlive: () => true });
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(), ["0.4.2-b", "0.4.4-c"]);
});

test("a generation held only by a live pin survives reclamation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-livepin-"));
  for (const name of ["0.3.9-orphan", "0.4.0-pinned-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await writePin({ root, harnessSessionId: "session-live",
    runtimeRoot: path.join(root, "generations", "0.4.0-pinned-only"),
    version: "0.4.0", storeVersion: 6, clientPid: process.pid });
  const result = await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.1-active"),
    pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.3.9-orphan"]);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-pinned-only", "0.4.1-active"]);
});

test("a pin whose client is confirmed dead does not save its generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-deadpin-"));
  for (const name of ["0.4.0-dead-pin-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await writePin({ root, harnessSessionId: "session-dead",
    runtimeRoot: path.join(root, "generations", "0.4.0-dead-pin-only"),
    version: "0.4.0", storeVersion: 6, clientPid: 999999 });
  const result = await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.1-active"),
    pidIsAlive: () => false });
  assert.deepEqual(result.removed, ["0.4.0-dead-pin-only"]);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.1-active"]);
});

test("a pin that cannot be read is an unknown holder and reclaim removes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-badpin-"));
  await mkdir(path.join(root, "generations", "0.4.0-would-be-orphan"), { recursive: true });
  const pinsDir = path.join(root, "pins");
  await mkdir(pinsDir, { recursive: true });
  await writeFile(path.join(pinsDir, "corrupt.json"), "not json");
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.0-would-be-orphan"]);
});

test("an unreadable lease is an unknown holder and reclaim removes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-retain-badlease-"));
  await mkdir(path.join(root, "generations", "0.4.0-would-be-orphan"), { recursive: true });
  const leasesDir = path.join(root, "leases");
  await mkdir(leasesDir, { recursive: true });
  await writeFile(path.join(leasesDir, "broken.json"), "null");
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.0-would-be-orphan"]);
});
