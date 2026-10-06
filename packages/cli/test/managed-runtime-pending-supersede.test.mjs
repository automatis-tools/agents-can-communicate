import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { performUpdate } from "../src/managed-runtime/worker.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";
import { cleanupStack, removeFixture } from "../../../tests/helpers/fixture-cleanup.mjs";

/**
 * A pending release that cannot activate kept every later one out (#277).
 *
 * On 2026-10-06 the maintainer's 0.10.0 stayed pending behind stale bindings;
 * after 0.10.1 fixed them, `acc update` still only retried 0.10.0, and 0.10.1
 * was staged only once `acc update --pin none` had cleared the pending release.
 */

async function fixture(t, changes = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-supersede-")));
  const defer = cleanupStack(t);
  defer(() => removeFixture(root));
  const active = { version: "0.9.1", root: path.join(root, "generations", "active") };
  const pending = { version: "0.10.0", root: path.join(root, "generations", "pending") };
  const newer = { version: "0.10.1", root: path.join(root, "generations", "newer") };
  for (const generation of [active, pending, newer]) await mkdir(generation.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true, pin: null,
    checkedAt: null, home: root, targets: [], notice: null, ...changes });
  const calls = [];
  let blocked = true;
  const ports = {
    env: {},
    discover: async () => { calls.push("discover"); return { version: newer.version }; },
    download: async () => { calls.push("download"); return { ...newer }; },
    activate: async () => {
      calls.push(`activate ${(await readControl(root)).pending.version}`);
      return blocked ? { activated: false, reason: "processes_active" } : { activated: true };
    },
  };
  return { root, calls, ports, unblock: () => { blocked = false; } };
}

test("acc update stages a newer release in place of a pending one that cannot activate", async t => {
  const f = await fixture(t);

  await performUpdate(f.root, { ...f.ports, force: true });

  assert.deepEqual(f.calls, ["activate 0.10.0", "discover", "download", "activate 0.10.1"]);
  assert.equal((await readControl(f.root)).pending.version, "0.10.1");
});

test("the automatic update looks for a newer release once a check is due", async t => {
  const due = await fixture(t);
  await performUpdate(due.root, due.ports);
  assert.deepEqual(due.calls, ["activate 0.10.0", "discover", "download", "activate 0.10.1"]);

  const recent = await fixture(t, { checkedAt: new Date().toISOString() });
  await performUpdate(recent.root, recent.ports);
  assert.deepEqual(recent.calls, ["activate 0.10.0"]);
  assert.equal((await readControl(recent.root)).pending.version, "0.10.0");
});

test("a pending release that activates is not replaced", async t => {
  const f = await fixture(t);
  f.unblock();

  await performUpdate(f.root, { ...f.ports, force: true });

  assert.deepEqual(f.calls, ["activate 0.10.0"]);
});

test("a release no newer than the pending one leaves it pending", async t => {
  const f = await fixture(t);
  const same = { ...f.ports, discover: async () => { f.calls.push("discover"); return { version: "0.10.0" }; } };

  const result = await performUpdate(f.root, { ...same, force: true });

  assert.deepEqual(f.calls, ["activate 0.10.0", "discover"]);
  assert.equal((await readControl(f.root)).pending.version, "0.10.0");
  // The command asks to restart a client service from this reason.
  assert.equal(result.reason, "processes_active");
});
