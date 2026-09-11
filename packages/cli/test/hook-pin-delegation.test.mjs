import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { STORE_VERSION } from "@agents-can-communicate/storage-filesystem";

import { resolvePinnedGeneration, writePin } from "../src/managed-runtime/pins.mjs";
import { canonicalManagerRoot } from "../src/managed-runtime/state.mjs";

test("a session pinned to another generation resolves that entrypoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  const pinned = path.join(root, "generations", "0.4.2-abc");
  await mkdir(path.join(pinned, "bin", "entrypoints"), { recursive: true });
  await writeFile(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs"), "export const main = () => {};");
  await writePin({ root, harnessSessionId: "h1", runtimeRoot: pinned, version: "0.4.2",
    storeVersion: STORE_VERSION, clientPid: process.pid });
  const active = path.join(root, "generations", "0.4.4-def");
  assert.equal(await resolvePinnedGeneration({ root, harnessSessionId: "h1", active }),
    await canonicalManagerRoot(pinned));
});

test("a session pinned to the active generation does not delegate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  const active = path.join(root, "generations", "0.4.4-def");
  await mkdir(path.join(active, "bin", "entrypoints"), { recursive: true });
  await writeFile(path.join(active, "bin", "entrypoints", "acc-hook.mjs"), "export const main = () => {};");
  await writePin({ root, harnessSessionId: "h2", runtimeRoot: active, version: "0.4.4",
    storeVersion: STORE_VERSION, clientPid: process.pid });
  assert.equal(await resolvePinnedGeneration({ root, harnessSessionId: "h2", active }), null);
});

test("a pinned generation removed from disk falls back to the active one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  await writePin({ root, harnessSessionId: "h3", runtimeRoot: path.join(root, "generations", "gone"),
    version: "0.4.2", storeVersion: STORE_VERSION, clientPid: process.pid });
  const active = path.join(root, "generations", "0.4.4-def");
  assert.equal(await resolvePinnedGeneration({ root, harnessSessionId: "h3", active }), null);
});

test("no pin falls back to the active generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  assert.equal(await resolvePinnedGeneration({ root, harnessSessionId: "absent",
    active: path.join(root, "generations", "0.4.4-def") }), null);
});

// Finding 1: the hook-runner writes a pin under a raw `<dataHome>/acc/runtime`
// it built itself; the hook reads pins under `managerRoot`, which entry.mjs
// has already realpath'd. A single shared `root` variable passed to both
// sides of a test can never exercise that gap - both derivations have to be
// built independently, the way production actually builds them, for a
// symlinked data home to matter.
//
// The symlink has to be the test's own, not borrowed from the host: relying
// on `/tmp` itself being a symlink (true on macOS via /private/tmp, false on
// a plain Linux /tmp) makes the fixture's self-check a fact about the CI
// runner rather than about the code, and fails on Linux for a reason that
// has nothing to do with the fix. A real directory plus a symlink this test
// creates and uses as the data home makes the divergence exist everywhere.
test("a pin written under the runner's raw data-home root is found by the hook's canonicalised root", async () => {
  const container = await mkdtemp(path.join(tmpdir(), "acc-datahome-"));
  const base = path.join(container, "real");
  const dataHome = path.join(container, "link");
  await mkdir(base, { recursive: true });
  await symlink(base, dataHome);

  // Mirrors packages/hook-runner/src/runner.mjs's managerRootFor: a plain
  // join off the data home, never realpath'd - built through the symlink.
  const writeRoot = path.join(dataHome, "acc", "runtime");
  // Mirrors managed-runtime/entry.mjs: every hook is handed a canonicalised
  // manager root.
  const readRoot = await canonicalManagerRoot(path.join(dataHome, "acc", "runtime"));
  // This assertion is the fixture's own self-check: it fails only if the
  // symlink above stopped mattering, never because of what the host's own
  // tmp directory happens to be.
  assert.notEqual(writeRoot, readRoot);

  const pinned = path.join(writeRoot, "generations", "0.4.2-abc");
  await mkdir(path.join(pinned, "bin", "entrypoints"), { recursive: true });
  await writeFile(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs"), "export const main = () => {};");
  await writePin({ root: writeRoot, harnessSessionId: "h-symlinked", runtimeRoot: pinned,
    version: "0.4.2", storeVersion: STORE_VERSION, clientPid: process.pid });

  const active = path.join(readRoot, "generations", "0.4.4-active");
  assert.equal(await resolvePinnedGeneration({ root: readRoot, harnessSessionId: "h-symlinked", active }),
    await canonicalManagerRoot(pinned));
});

// Finding 2: a pin's runtimeRoot is data written by whatever process last held
// this harness session, not a value this process has any other reason to
// trust. An unmanaged hook run sharing a data home records a pin whose
// runtimeRoot is a development checkout's own repository root (runtimeFacts
// walks up to the nearest accStoreVersion manifest, which for an unmanaged
// run is that checkout). A later managed hook must refuse to import it, the
// same way validateRuntime already refuses a control record's generation
// pointer that lands outside <root>/generations.
test("a pin naming a generation outside the manager's own generations directory is refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  const outside = await mkdtemp(path.join(tmpdir(), "acc-outside-"));
  await mkdir(path.join(outside, "bin", "entrypoints"), { recursive: true });
  // A real, importable entrypoint - proves refusal comes from containment,
  // not merely from the file being unreachable.
  await writeFile(path.join(outside, "bin", "entrypoints", "acc-hook.mjs"), "export const main = () => {};");
  await writePin({ root, harnessSessionId: "h-outside", runtimeRoot: outside, version: "9.9.9",
    storeVersion: STORE_VERSION, clientPid: process.pid });
  const active = path.join(root, "generations", "0.4.4-def");
  assert.equal(await resolvePinnedGeneration({ root, harnessSessionId: "h-outside", active }), null);
});

// Minor: covers the resolve level directly rather than leaning on Task 7's
// readPin tests alone - every failure path this task owns should be pinned by
// a test at the level this task added.
test("an unreadable pin record falls back to the active generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  const canonicalRoot = await canonicalManagerRoot(root);
  await mkdir(path.join(canonicalRoot, "pins"), { recursive: true });
  const file = path.join(canonicalRoot, "pins",
    `${createHash("sha256").update("h-corrupt").digest("hex").slice(0, 32)}.json`);
  await writeFile(file, "{ this is not valid json");
  const active = path.join(root, "generations", "0.4.4-def");
  assert.equal(await resolvePinnedGeneration({ root, harnessSessionId: "h-corrupt", active }), null);
});

// Final review, Finding 1: a pin is deliberately not an activation hold, so a
// harness that lives only in hooks holds nothing between turns and cannot keep
// an activation waiting. An activation to a generation declaring a different
// STORE_VERSION therefore proceeds - correctly - but the pin survives it, and
// delegating into the generation it names would run code the store refuses by
// strict equality: `unknown store version` on every hook, falling open for the
// rest of the session's life while the pin held the dead generation against
// reclamation.
//
// Non-vacuousness is proved inside the test rather than asserted about it: the
// three halves build byte-identical fixtures - same manager root shape, same
// contained generation directory, same importable entrypoint, same live PID -
// and differ in exactly one value, the pin's declared contract. The first is
// the control and must delegate; if the gate were removed the others would
// answer the same way and the test would fail.
test("a pin declaring a store contract other than this generation's is not delegated to", async () => {
  const fixture = async (harnessSessionId, storeVersion) => {
    const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-contract-"));
    const pinned = path.join(root, "generations", "0.4.2-abc");
    await mkdir(path.join(pinned, "bin", "entrypoints"), { recursive: true });
    await writeFile(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs"),
      "export const main = () => {};");
    await writePin({ root, harnessSessionId, runtimeRoot: pinned, version: "0.4.2",
      storeVersion, clientPid: process.pid });
    return { root, pinned, active: path.join(root, "generations", "0.4.4-def") };
  };

  const matching = await fixture("h-contract-same", STORE_VERSION);
  assert.equal(await resolvePinnedGeneration({ root: matching.root,
    harnessSessionId: "h-contract-same", active: matching.active }),
  await canonicalManagerRoot(matching.pinned),
  "control: an otherwise identical pin declaring this generation's contract must delegate");

  const newer = await fixture("h-contract-newer", STORE_VERSION + 1);
  assert.equal(await resolvePinnedGeneration({ root: newer.root,
    harnessSessionId: "h-contract-newer", active: newer.active }), null);

  const older = await fixture("h-contract-older", STORE_VERSION - 1);
  assert.equal(await resolvePinnedGeneration({ root: older.root,
    harnessSessionId: "h-contract-older", active: older.active }), null);
});

// A pin written before the contract field existed, or by a generation whose
// root manifest declares none, carries null. Unknown cannot be proved equal,
// and this function's answer to every pin it cannot honour is the active
// generation.
test("a pin declaring no store contract at all is not delegated to", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-nocontract-"));
  const pinned = path.join(root, "generations", "0.4.2-abc");
  await mkdir(path.join(pinned, "bin", "entrypoints"), { recursive: true });
  await writeFile(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs"), "export const main = () => {};");
  await writePin({ root, harnessSessionId: "h-contract-absent", runtimeRoot: pinned,
    version: "0.4.2", storeVersion: null, clientPid: process.pid });
  const active = path.join(root, "generations", "0.4.4-def");
  assert.equal(await resolvePinnedGeneration({ root, harnessSessionId: "h-contract-absent", active }), null);
});
