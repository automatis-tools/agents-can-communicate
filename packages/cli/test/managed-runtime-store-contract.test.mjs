import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateRuntime } from "../src/managed-runtime/state.mjs";
import { fixtureRoot } from "../../../tests/helpers/temp-workspace.mjs";

// realpath avoids a false "outside manager generations" failure on platforms
// (e.g. macOS) where the OS temp directory is itself a symlink.
const managerRoot = async t => {
  const root = await realpath(await fixtureRoot(t, "acc-contract-"));
  await mkdir(path.join(root, "generations", "0.4.4-abc"), { recursive: true });
  return root;
};

test("a generation pointer carries the store contract it declares", async t => {
  const root = await managerRoot(t);
  const runtime = { version: "0.4.4", root: path.join(root, "generations", "0.4.4-abc"),
    storeVersion: 6 };
  assert.equal((await validateRuntime(root, runtime)).storeVersion, 6);
});

test("a pointer written before the contract field reads as an unknown contract", async t => {
  const root = await managerRoot(t);
  const runtime = { version: "0.4.2", root: path.join(root, "generations", "0.4.4-abc") };
  assert.equal((await validateRuntime(root, runtime)).storeVersion, null);
});

test("a malformed contract is refused rather than silently dropped", async t => {
  const root = await managerRoot(t);
  const runtime = { version: "0.4.4", root: path.join(root, "generations", "0.4.4-abc"),
    storeVersion: "6" };
  await assert.rejects(() => validateRuntime(root, runtime), /invalid control generation/);
});
