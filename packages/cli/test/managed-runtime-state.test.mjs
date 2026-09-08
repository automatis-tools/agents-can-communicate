import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";
import { withManagerLock } from "../src/managed-runtime/mutex.mjs";

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "acc-manager-state-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "manager");
  const active = { version: "0.4.0", root: path.join(root, "generations", "a") };
  const control = { schemaVersion: 1, active, pending: null, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: parent, targets: [], notice: null };
  return { parent, root, control };
}

async function initialize(f) {
  await mkdir(f.control.active.root, { recursive: true });
  await writeControl(f.root, f.control);
}

test("absent control read leaves the manager uninitialized", async t => {
  const f = await fixture(t);
  assert.equal(await readControl(f.root), null);
  assert.deepEqual(await readdir(f.parent), []);
});

test("control roundtrip is private and refuses malformed or escaping runtime pointers", async t => {
  const f = await fixture(t);
  await initialize(f);
  assert.deepEqual(await readControl(f.root), f.control);
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.root, "control.json"))).mode & 0o777, 0o600);
  for (const bad of [{ ...f.control, phase: "guess" }, { ...f.control, auto: 1 },
    { ...f.control, active: { version: "0.4.0", root: f.parent } },
    { ...f.control, pending: { version: "0.5.0", root: f.parent } }]) {
    await assert.rejects(writeControl(f.root, bad), /control|generation/i);
  }
  await writeFile(path.join(f.root, "control.json"), "{}");
  await assert.rejects(readControl(f.root), /control/i);
});

test("control refuses symlink files and generation escapes through symlinks", async t => {
  const f = await fixture(t);
  await initialize(f);
  await rm(path.join(f.root, "control.json"));
  const outside = path.join(f.parent, "outside.json");
  await writeFile(outside, JSON.stringify(f.control));
  await symlink(outside, path.join(f.root, "control.json"));
  await assert.rejects(readControl(f.root), /symbolic|symlink|ELOOP/i);
  await rm(path.join(f.root, "control.json"));
  await symlink(f.parent, path.join(f.root, "generations", "escape"));
  await assert.rejects(writeControl(f.root, { ...f.control,
    active: { version: "0.4.0", root: path.join(f.root, "generations", "escape") } }), /generation/i);
});

test("old live or unknown lock owners are never reclaimed", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "manager.lock"), { recursive: true });
  const owner = { pid: process.pid, token: "old-owner", acquiredAt: "2000-01-01T00:00:00.000Z" };
  await writeFile(path.join(f.root, "manager.lock", "owner.json"), JSON.stringify(owner));
  for (const pidIsAlive of [() => true, () => undefined, () => { throw Object.assign(new Error("unknown"), { code: "EPERM" }); }]) {
    await assert.rejects(withManagerLock(f.root, () => "unexpected admission",
      { timeoutMs: 35, pidIsAlive }), /lock|held|timeout/i);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.root, "manager.lock", "owner.json"))), owner);
  }
});

test("dead lock reclaim retains a nonempty deterministic tombstone", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "manager.lock"), { recursive: true });
  const owner = { pid: 123456789, token: "dead-owner", acquiredAt: "2000-01-01T00:00:00.000Z" };
  await writeFile(path.join(f.root, "manager.lock", "owner.json"), JSON.stringify(owner));
  const identity = createHash("sha256").update(JSON.stringify([owner.pid, owner.token, owner.acquiredAt])).digest("hex");
  const tombstone = path.join(f.root, `manager.reclaimed-${identity}.lock`);
  assert.equal(await withManagerLock(f.root, () => 42, { pidIsAlive: () => false }), 42);
  assert.deepEqual(JSON.parse(await readFile(path.join(tombstone, "owner.json"))), owner);
});

test("malformed and ownerless locks block instead of being guessed dead", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "manager.lock"), { recursive: true });
  await assert.rejects(withManagerLock(f.root, () => "unexpected admission"), /owner|lock/i);
  await writeFile(path.join(f.root, "manager.lock", "owner.json"), "{}");
  await assert.rejects(withManagerLock(f.root, () => "unexpected admission"), /owner|lock/i);
});

test("release checks its ownership token before touching a replacement lock", async t => {
  const f = await fixture(t);
  const file = path.join(f.root, "manager.lock", "owner.json");
  await withManagerLock(f.root, async () => {
    const owner = JSON.parse(await readFile(file));
    await writeFile(file, JSON.stringify({ ...owner, token: "replacement" }));
  });
  assert.equal(JSON.parse(await readFile(file)).token, "replacement");
});

test("a stale dead-owner observer cannot retire a live successor", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, "manager.lock");
  await mkdir(directory, { recursive: true });
  const owner = { pid: 123456789, token: "observed-dead", acquiredAt: "2000-01-01T00:00:00.000Z" };
  await writeFile(path.join(directory, "owner.json"), JSON.stringify(owner));
  let observed, resume;
  const sawOwner = new Promise(resolve => { observed = resolve; });
  const resumeProbe = new Promise(resolve => { resume = resolve; });
  const stale = withManagerLock(f.root, () => "evicted successor", { timeoutMs: 180,
    pidIsAlive: async pid => {
      if (pid !== owner.pid) return true;
      observed(); await resumeProbe; return false;
    } });
  const blocked = assert.rejects(stale, /lock|timeout/i);
  await sawOwner;
  let release, acquired;
  const successorAcquired = new Promise(resolve => { acquired = resolve; });
  const releaseSuccessor = new Promise(resolve => { release = resolve; });
  const successor = withManagerLock(f.root, async () => {
    acquired(); await releaseSuccessor;
  }, { pidIsAlive: pid => pid !== owner.pid });
  await successorAcquired;
  const successorOwner = JSON.parse(await readFile(path.join(directory, "owner.json")));
  resume();
  try {
    await blocked;
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "owner.json"))), successorOwner);
  } finally { release(); await successor; }
});

test("literal null control is malformed rather than an absent installation", async t => {
  const f = await fixture(t);
  await initialize(f);
  await writeFile(path.join(f.root, "control.json"), "null");
  await assert.rejects(readControl(f.root), /control/i);
});

test("lock inspection retries when a successor appears after owner open saw ENOENT", async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, "manager.lock");
  const replacement = path.join(f.root, "prepared-successor.lock");
  await mkdir(directory, { recursive: true });
  await mkdir(replacement);
  const previous = { pid: 123456789, token: "previous", acquiredAt: "2000-01-01T00:00:00.000Z" };
  const successor = { ...previous, pid: process.pid, token: "successor" };
  const file = path.join(directory, "owner.json");
  await writeFile(file, JSON.stringify(previous));
  await writeFile(path.join(replacement, "owner.json"), JSON.stringify(successor));
  const originalOpen = fs.open;
  let interleaved = false;
  // Keep the real open's ENOENT, but publish B before A's failed open returns.
  // This deterministically exercises the otherwise tiny pathname transition.
  fs.open = async (target, ...args) => {
    if (target !== file || interleaved) return originalOpen(target, ...args);
    interleaved = true;
    await rename(directory, path.join(f.root, "retired-previous.lock"));
    let missing;
    try { await originalOpen(target, ...args); }
    catch (error) { missing = error; }
    assert.equal(missing?.code, "ENOENT");
    await rename(replacement, directory);
    throw missing;
  };
  syncBuiltinESMExports();
  let observedSuccessor = false;
  try {
    const result = await withManagerLock(f.root, () => "admitted", {
      pidIsAlive: async pid => {
        assert.equal(pid, process.pid);
        assert.deepEqual(JSON.parse(await readFile(file)), successor);
        observedSuccessor = true;
        await rename(directory, path.join(f.root, "retired-successor.lock"));
        return true;
      },
    });
    assert.equal(result, "admitted");
    assert.equal(observedSuccessor, true);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});
