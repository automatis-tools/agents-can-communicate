import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { activatePending, reclaimGenerations } from "../src/managed-runtime/activation.mjs";
import { writePin } from "../src/managed-runtime/pins.mjs";
import { writeControl, writeManagedJson } from "../src/managed-runtime/state.mjs";
import { fixtureRoot } from "../../../tests/helpers/temp-workspace.mjs";

// Every scenario below runs against a real, written control.json: an absent
// one now postpones the whole pass (Finding 4), so a test that wants to
// prove something survives - or is genuinely removed - needs a real control
// to reach the code being tested at all.
async function fixtureControl(root, { active, pending = null, phase = "ready" } = {}) {
  await writeControl(root, { schemaVersion: 1, active: { version: "0.0.0", root: active },
    pending: pending ? { version: "0.0.1", root: pending } : null, phase,
    auto: true, pin: null, checkedAt: null, home: root, targets: [], notice: null });
}

async function writeLease(root, name, runtimeRoot) {
  const directory = path.join(root, "leases");
  await mkdir(directory, { recursive: true });
  await writeManagedJson(path.join(directory, `${name}.json`), { schemaVersion: 1, token: name,
    pid: process.pid, kind: "cli", runtime: { version: "0.4.0", root: runtimeRoot },
    createdAt: new Date().toISOString() });
}

test("an unreferenced generation is removed and a pinned one is kept", async t => {
  const root = await fixtureRoot(t, "acc-retain-");
  for (const name of ["0.4.0-a", "0.4.2-b", "0.4.4-c"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.4-c") });
  await writePin({ root, harnessSessionId: "h1",
    runtimeRoot: path.join(root, "generations", "0.4.2-b"), version: "0.4.2",
    storeVersion: 6, clientPid: process.pid });
  await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.4-c"),
    pidIsAlive: () => true });
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(), ["0.4.2-b", "0.4.4-c"]);
});

test("a generation held only by a live pin survives reclamation", async t => {
  const root = await fixtureRoot(t, "acc-retain-livepin-");
  for (const name of ["0.3.9-orphan", "0.4.0-pinned-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  await writePin({ root, harnessSessionId: "session-live",
    runtimeRoot: path.join(root, "generations", "0.4.0-pinned-only"),
    version: "0.4.0", storeVersion: 6, clientPid: process.pid });
  const result = await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.1-active"),
    pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.3.9-orphan"]);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-pinned-only", "0.4.1-active"]);
});

test("a pin whose client is confirmed dead does not save its generation", async t => {
  const root = await fixtureRoot(t, "acc-retain-deadpin-");
  for (const name of ["0.4.0-dead-pin-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  await writePin({ root, harnessSessionId: "session-dead",
    runtimeRoot: path.join(root, "generations", "0.4.0-dead-pin-only"),
    version: "0.4.0", storeVersion: 6, clientPid: 999999 });
  const result = await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.1-active"),
    pidIsAlive: () => false });
  assert.deepEqual(result.removed, ["0.4.0-dead-pin-only"]);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.1-active"]);
});

test("a pin that names no client does not save its generation", async t => {
  // 0.5.x to 0.8.0 could write a pin before the client's pid was known, and
  // nothing can ever prove such a pin's session over.
  const root = await fixtureRoot(t, "acc-retain-pidlesspin-");
  for (const name of ["0.4.0-pidless-pin-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  await mkdir(path.join(root, "pins"), { recursive: true, mode: 0o700 });
  await writeManagedJson(path.join(root, "pins", "legacy.json"), { schemaVersion: 1,
    harnessSessionId: "session-pidless", runtimeRoot: path.join(root, "generations", "0.4.0-pidless-pin-only"),
    version: "0.4.0", storeVersion: 6, clientPid: null, createdAt: new Date().toISOString() });
  const result = await reclaimGenerations({ root, active: path.join(root, "generations", "0.4.1-active"),
    pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.4.0-pidless-pin-only"]);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.1-active"]);
});

test("a pin that cannot be read is an unknown holder and reclaim removes nothing", async t => {
  const root = await fixtureRoot(t, "acc-retain-badpin-");
  await mkdir(path.join(root, "generations", "0.4.0-would-be-orphan"), { recursive: true });
  await mkdir(path.join(root, "generations", "0.4.1-active"), { recursive: true });
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  const pinsDir = path.join(root, "pins");
  await mkdir(pinsDir, { recursive: true });
  await writeFile(path.join(pinsDir, "corrupt.json"), "not json");
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-would-be-orphan", "0.4.1-active"]);
});

test("an unreadable lease is an unknown holder and reclaim removes nothing", async t => {
  const root = await fixtureRoot(t, "acc-retain-badlease-");
  await mkdir(path.join(root, "generations", "0.4.0-would-be-orphan"), { recursive: true });
  await mkdir(path.join(root, "generations", "0.4.1-active"), { recursive: true });
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  const leasesDir = path.join(root, "leases");
  await mkdir(leasesDir, { recursive: true });
  await writeFile(path.join(leasesDir, "broken.json"), "null");
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-would-be-orphan", "0.4.1-active"]);
});

test("control's own active and pending pointers protect their generations without an explicit active override", async t => {
  const root = await fixtureRoot(t, "acc-retain-control-");
  for (const name of ["0.3.0-orphan", "0.4.0-active-from-control", "0.4.1-pending-from-control"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.0-active-from-control"),
    pending: path.join(root, "generations", "0.4.1-pending-from-control"), phase: "activating" });
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.3.0-orphan"]);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-active-from-control", "0.4.1-pending-from-control"]);
});

test("a generation held only by a live runtime lease survives reclamation", async t => {
  const root = await fixtureRoot(t, "acc-retain-livelease-");
  for (const name of ["0.3.9-orphan", "0.4.0-leased-only", "0.4.1-active"]) {
    await mkdir(path.join(root, "generations", name), { recursive: true });
  }
  await fixtureControl(root, { active: path.join(root, "generations", "0.4.1-active") });
  await writeLease(root, "aaaa", path.join(root, "generations", "0.4.0-leased-only"));
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, ["0.3.9-orphan"]);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(),
    ["0.4.0-leased-only", "0.4.1-active"]);
});

test("activatePending reclaims the superseded generation once the new one is active", async t => {
  const dataHome = await realpath(await fixtureRoot(t, "acc-retain-wiring-"));
  const root = path.join(dataHome, "acc", "runtime");
  const active = { version: "0.4.0", root: path.join(root, "generations", "old-gen") };
  const pending = { version: "0.4.1", root: path.join(root, "generations", "new-gen") };
  await mkdir(active.root, { recursive: true });
  await mkdir(pending.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: dataHome, targets: [], notice: null });
  const result = await activatePending(root, { prepare: async () => async () => ({ failed: [] }) });
  assert.equal(result.activated, true);
  assert.deepEqual((await readdir(path.join(root, "generations"))).sort(), ["new-gen"]);
});

test("a manager root with generations but no control.json is an unknown state and reclaim removes nothing", async t => {
  const root = await fixtureRoot(t, "acc-retain-nocontrol-");
  await mkdir(path.join(root, "generations", "0.4.0-orphan"), { recursive: true });
  const result = await reclaimGenerations({ root, active: null, pidIsAlive: () => true });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(await readdir(path.join(root, "generations")), ["0.4.0-orphan"]);
});

// #208: the code that activates is the older one; the activated generation's
// own rule runs right after, from its own files, and records it.
test("activatePending runs the activated generation's own reclaim", async t => {
  const dataHome = await realpath(await fixtureRoot(t, "acc-retain-own-rule-"));
  const root = path.join(dataHome, "acc", "runtime");
  const active = { version: "0.4.0", root: path.join(root, "generations", "old-gen") };
  const pending = { version: "0.4.1", root: path.join(root, "generations", "new-gen") };
  await mkdir(active.root, { recursive: true });
  const managed = path.join(pending.root, "node_modules", "@agents-can-communicate", "cli", "src",
    "managed-runtime");
  await mkdir(managed, { recursive: true });
  await writeFile(path.join(managed, "worker.mjs"), `import { writeFile } from "node:fs/promises";
export async function reclaimAsActive(root, generationRoot) {
  await writeFile(${JSON.stringify(path.join(dataHome, "own-rule.json"))}, JSON.stringify({ root, generationRoot }));
}
`);
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: dataHome, targets: [], notice: null });
  const result = await activatePending(root, { prepare: async () => async () => ({ failed: [] }) });
  assert.equal(result.activated, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataHome, "own-rule.json"), "utf8")),
    { root, generationRoot: pending.root });
});
