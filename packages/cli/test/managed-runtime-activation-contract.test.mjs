import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { activationBlockerNotice, blocksActivation, listActivationBlockers } from "../src/managed-runtime/activation.mjs";
import { writeControl, writeManagedJson } from "../src/managed-runtime/state.mjs";

test("a notice names the declared contract of each blocking hold", () => {
  const notice = activationBlockerNotice("0.4.5", [
    { pid: 4242, kinds: ["acc-claude-channel"], nativeBindings: 0, storeVersion: null,
      reason: "process_running" },
  ]);
  assert.match(notice, /PID 4242/);
  assert.match(notice, /contract unknown/);
});

test("a notice reports a differing contract as the reason", () => {
  const notice = activationBlockerNotice("0.5.0", [
    { pid: 77, kinds: ["native"], nativeBindings: 2, storeVersion: 6, reason: "process_running" },
  ]);
  assert.match(notice, /store contract 6/);
});

test("a hold blocks only when its declared contract is unknown or different", () => {
  assert.equal(blocksActivation({ storeVersion: 6 }, 6), false);
  assert.equal(blocksActivation({ storeVersion: 6 }, 7), true);
  assert.equal(blocksActivation({ storeVersion: null }, 6), true);
  // An incoming generation that declares nothing cannot be judged, so nothing
  // is allowed past. This is the pre-Task-1 generation case.
  assert.equal(blocksActivation({ storeVersion: 6 }, null), true);
});

// The predicate alone cannot see a per-PID merge bug: it only ever receives
// one already-collapsed hold. These run the real filesystem-backed function,
// with multiple lease files for the same PID, the way a live process
// actually publishes several holds.
async function fixture(t, { pendingStoreVersion } = {}) {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "acc-activation-contract-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "acc", "runtime");
  const active = { version: "0.4.0", root: path.join(root, "generations", "old") };
  const pending = { version: "0.4.1", root: path.join(root, "generations", "new"),
    ...(pendingStoreVersion === undefined ? {} : { storeVersion: pendingStoreVersion }) };
  await mkdir(active.root, { recursive: true });
  await mkdir(pending.root, { recursive: true });
  const control = await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: path.join(data, "home"), targets: [], notice: null });
  return { root, control };
}

// A lease file name has nothing to do with when its process acquired it;
// `token` is a random UUID. Writing named files directly is the only way to
// pin which one a lexical directory listing reads first.
async function writeLease(root, name, { storeVersion } = {}) {
  const directory = path.join(root, "leases");
  await mkdir(directory, { recursive: true });
  await writeManagedJson(path.join(directory, `${name}.json`), { schemaVersion: 1, token: name,
    pid: process.pid, kind: "cli",
    runtime: { version: "0.4.0", root: path.join(root, "generations", "old"),
      ...(storeVersion === undefined ? {} : { storeVersion }) },
    createdAt: new Date().toISOString() });
}

test("one PID holding leases that declare different known contracts blocks, regardless of which file sorts first", async t => {
  for (const [first, second] of [[6, 7], [7, 6]]) {
    const f = await fixture(t);
    await writeLease(f.root, "aaaa", { storeVersion: first });
    await writeLease(f.root, "bbbb", { storeVersion: second });
    const blockers = await listActivationBlockers(f.root, { incomingStoreVersion: 6 });
    assert.equal(blockers.length, 1, `first=${first} second=${second} must still block`);
    assert.equal(blockers[0].pid, process.pid);
    // The merge itself must report the process as uncomparable, not silently
    // keep whichever contract it happened to read first.
    assert.equal(blockers[0].storeVersion, null);
  }
});

test("a pre-existing lease declaring no contract still blocks a pending generation that declares one", async t => {
  const f = await fixture(t, { pendingStoreVersion: 6 });
  await writeLease(f.root, "aaaa");
  const blockers = await listActivationBlockers(f.root, { incomingStoreVersion: f.control.pending.storeVersion });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].storeVersion, null);
});

test("a lease declaring a contract different from the incoming generation blocks", async t => {
  const f = await fixture(t, { pendingStoreVersion: 6 });
  await writeLease(f.root, "aaaa", { storeVersion: 7 });
  const blockers = await listActivationBlockers(f.root, { incomingStoreVersion: f.control.pending.storeVersion });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].storeVersion, 7);
});
