import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { clearPin, readPin, reapPins, writePin } from "../src/managed-runtime/pins.mjs";
import { fixtureRoot } from "../../../tests/helpers/temp-workspace.mjs";

const root = t => fixtureRoot(t, "acc-pins-");
const pin = { harnessSessionId: "harness-1", runtimeRoot: "/generations/0.4.2-abc",
  version: "0.4.2", storeVersion: 6, clientPid: 4242 };

test("a pin round-trips by harness session id", async t => {
  const dir = await root(t);
  await writePin({ root: dir, ...pin });
  assert.equal((await readPin({ root: dir, harnessSessionId: "harness-1" })).version, "0.4.2");
});

test("an unknown session has no pin", async t => {
  assert.equal(await readPin({ root: await root(t), harnessSessionId: "absent" }), null);
});

test("clearing removes it", async t => {
  const dir = await root(t);
  await writePin({ root: dir, ...pin });
  await clearPin({ root: dir, harnessSessionId: "harness-1" });
  assert.equal(await readPin({ root: dir, harnessSessionId: "harness-1" }), null);
});

test("a pin whose client is confirmed dead is reaped", async t => {
  const dir = await root(t);
  await writePin({ root: dir, ...pin });
  await reapPins({ root: dir, pidIsAlive: () => false });
  assert.equal(await readPin({ root: dir, harnessSessionId: "harness-1" }), null);
});

test("a pin whose client is alive survives a reap", async t => {
  const dir = await root(t);
  await writePin({ root: dir, ...pin });
  await reapPins({ root: dir, pidIsAlive: () => true });
  assert.notEqual(await readPin({ root: dir, harnessSessionId: "harness-1" }), null);
});

// What 0.5.x to 0.8.0 left behind: a pin written before, or without, the
// client's pid was known. Written as raw bytes because writePin no longer
// produces this shape.
const writeLegacyPin = async (dir, harnessSessionId) => {
  const directory = path.join(dir, "pins");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory,
    `${createHash("sha256").update(harnessSessionId).digest("hex").slice(0, 32)}.json`),
  JSON.stringify({ schemaVersion: 1, harnessSessionId, runtimeRoot: "/generations/0.4.2-abc",
    version: "0.4.2", storeVersion: 6, clientPid: null, createdAt: new Date().toISOString() }));
};

test("a session whose client pid is unknown gets no pin", async t => {
  const dir = await root(t);
  await writePin({ root: dir, ...pin, clientPid: undefined });
  await writePin({ root: dir, ...pin, harnessSessionId: "harness-2", clientPid: null });
  assert.equal(await readPin({ root: dir, harnessSessionId: "harness-1" }), null);
  assert.equal(await readPin({ root: dir, harnessSessionId: "harness-2" }), null);
});

test("a pin that names no client is reaped, since nothing could prove it dead", async t => {
  const dir = await root(t);
  await writeLegacyPin(dir, "harness-legacy");
  assert.notEqual(await readPin({ root: dir, harnessSessionId: "harness-legacy" }), null);
  await reapPins({ root: dir, pidIsAlive: () => true });
  assert.equal(await readPin({ root: dir, harnessSessionId: "harness-legacy" }), null);
});
