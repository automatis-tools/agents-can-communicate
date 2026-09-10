import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePinnedEntrypoint, writePin } from "../src/managed-runtime/pins.mjs";

test("a session pinned to another generation resolves that entrypoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  const pinned = path.join(root, "generations", "0.4.2-abc");
  await mkdir(path.join(pinned, "bin", "entrypoints"), { recursive: true });
  await writeFile(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs"), "export const main = () => {};");
  await writePin({ root, harnessSessionId: "h1", runtimeRoot: pinned, version: "0.4.2",
    storeVersion: 6, clientPid: process.pid });
  const active = path.join(root, "generations", "0.4.4-def");
  assert.equal(await resolvePinnedEntrypoint({ root, harnessSessionId: "h1", active }), pinned);
});

test("a session pinned to the active generation does not delegate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  const active = path.join(root, "generations", "0.4.4-def");
  await mkdir(path.join(active, "bin", "entrypoints"), { recursive: true });
  await writeFile(path.join(active, "bin", "entrypoints", "acc-hook.mjs"), "export const main = () => {};");
  await writePin({ root, harnessSessionId: "h2", runtimeRoot: active, version: "0.4.4",
    storeVersion: 6, clientPid: process.pid });
  assert.equal(await resolvePinnedEntrypoint({ root, harnessSessionId: "h2", active }), null);
});

test("a pinned generation removed from disk falls back to the active one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  await writePin({ root, harnessSessionId: "h3", runtimeRoot: path.join(root, "generations", "gone"),
    version: "0.4.2", storeVersion: 6, clientPid: process.pid });
  const active = path.join(root, "generations", "0.4.4-def");
  assert.equal(await resolvePinnedEntrypoint({ root, harnessSessionId: "h3", active }), null);
});

test("no pin falls back to the active generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-delegate-"));
  assert.equal(await resolvePinnedEntrypoint({ root, harnessSessionId: "absent",
    active: path.join(root, "generations", "0.4.4-def") }), null);
});
