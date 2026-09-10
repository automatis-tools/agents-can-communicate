import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { retireManagedHolds } from "../src/managed-runtime/retire.mjs";

const layout = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "acc-retire-"));
  const root = path.join(home, "runtime");
  const workspaces = path.join(home, "workspaces");
  const bindings = path.join(workspaces, "workspace_a", "bindings");
  await mkdir(bindings, { recursive: true });
  await mkdir(path.join(root, "generations", "0.4.4-c"), { recursive: true });
  await writeFile(path.join(bindings, "aaaa.json"), JSON.stringify({ schemaVersion: 1,
    harnessSessionId: "h1", accSessionId: "session_a", generation: "generation_a",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: process.pid,
    storeVersion: 6, runtimeRoot: path.join(root, "generations", "0.4.4-c") }));
  return { root, workspaces, bindings };
};

// Task 7 (packages/cli/src/managed-runtime/pins.mjs, exporting writePin) has not
// landed in this worktree's base. retireManagedHolds does not import pins.mjs
// itself, it only clears *.json files under root/pins directly, so this fixture
// writes a pin record in exactly the shape Task 7's writePin brief specifies
// without depending on that module.
const writePinFixture = async ({ root, harnessSessionId, runtimeRoot, version, storeVersion,
  clientPid }) => {
  const directory = path.join(root, "pins");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory,
    `${createHash("sha256").update(String(harnessSessionId)).digest("hex").slice(0, 32)}.json`);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, harnessSessionId, runtimeRoot, version,
    storeVersion, clientPid, createdAt: new Date().toISOString() }));
};

test("uninstall retires the bindings and pins this manager published", async () => {
  const { root, workspaces, bindings } = await layout();
  await writePinFixture({ root, harnessSessionId: "h1",
    runtimeRoot: path.join(root, "generations", "0.4.4-c"), version: "0.4.4",
    storeVersion: 6, clientPid: process.pid });
  const result = await retireManagedHolds({ root, workspaces });
  assert.deepEqual(result, { bindings: 1, pins: 1 });
  assert.deepEqual(await readdir(bindings), []);
  assert.deepEqual(await readdir(path.join(root, "pins")), []);
});

test("a binding published by another manager is left alone", async () => {
  const { root, workspaces, bindings } = await layout();
  await writeFile(path.join(bindings, "bbbb.json"), JSON.stringify({ schemaVersion: 1,
    harnessSessionId: "h2", accSessionId: "session_b", generation: "generation_b",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: process.pid,
    storeVersion: 6, runtimeRoot: "/somewhere/else/generations/0.4.4-c" }));
  await retireManagedHolds({ root, workspaces });
  assert.deepEqual(await readdir(bindings), ["bbbb.json"]);
});

test("a binding naming a relative runtimeRoot is left alone regardless of the caller's cwd", async () => {
  const { root, workspaces, bindings } = await layout();
  const owned = path.join(root, "generations", "0.4.4-c");
  // Chosen so that resolving it against process.cwd() reconstructs the exact
  // in-bounds generation path: if ownership were decided without requiring an
  // absolute runtimeRoot, this would be misclassified as owned purely because
  // of where the test happens to run from.
  const relative = path.relative(process.cwd(), owned);
  await writeFile(path.join(bindings, "cccc.json"), JSON.stringify({ schemaVersion: 1,
    harnessSessionId: "h3", accSessionId: "session_c", generation: "generation_c",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: process.pid,
    storeVersion: 6, runtimeRoot: relative }));
  await retireManagedHolds({ root, workspaces });
  assert.deepEqual(await readdir(bindings), ["cccc.json"]);
});

test("a binding naming the generations directory itself, not a generation inside it, is left alone", async () => {
  const { root, workspaces, bindings } = await layout();
  await writeFile(path.join(bindings, "dddd.json"), JSON.stringify({ schemaVersion: 1,
    harnessSessionId: "h4", accSessionId: "session_d", generation: "generation_d",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: process.pid,
    storeVersion: 6, runtimeRoot: path.join(root, "generations") }));
  await retireManagedHolds({ root, workspaces });
  assert.deepEqual(await readdir(bindings), ["dddd.json"]);
});
