import assert from "node:assert/strict";
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
