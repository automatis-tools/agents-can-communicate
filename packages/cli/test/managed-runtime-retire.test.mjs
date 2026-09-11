import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { isOwnedRuntimeRoot, retireManagedHolds } from "../src/managed-runtime/retire.mjs";
import { fixtureRoot } from "../../../tests/helpers/temp-workspace.mjs";

const layout = async t => {
  const home = await fixtureRoot(t, "acc-retire-");
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

// retireManagedHolds never imports pins.mjs; it clears *.json under root/pins
// directly. This fixture writes the same record shape writePin produces, so a
// change in how pins are written cannot quietly make this test pass or fail for
// a reason that has nothing to do with retirement.
const writePinFixture = async ({ root, harnessSessionId, runtimeRoot, version, storeVersion,
  clientPid }) => {
  const directory = path.join(root, "pins");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory,
    `${createHash("sha256").update(String(harnessSessionId)).digest("hex").slice(0, 32)}.json`);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, harnessSessionId, runtimeRoot, version,
    storeVersion, clientPid, createdAt: new Date().toISOString() }));
};

test("uninstall retires the bindings and pins this manager published", async t => {
  const { root, workspaces, bindings } = await layout(t);
  await writePinFixture({ root, harnessSessionId: "h1",
    runtimeRoot: path.join(root, "generations", "0.4.4-c"), version: "0.4.4",
    storeVersion: 6, clientPid: process.pid });
  const result = await retireManagedHolds({ root, workspaces });
  assert.deepEqual(result, { bindings: 1, pins: 1 });
  assert.deepEqual(await readdir(bindings), []);
  assert.deepEqual(await readdir(path.join(root, "pins")), []);
});

test("a binding published by another manager is left alone", async t => {
  const { root, workspaces, bindings } = await layout(t);
  await writeFile(path.join(bindings, "bbbb.json"), JSON.stringify({ schemaVersion: 1,
    harnessSessionId: "h2", accSessionId: "session_b", generation: "generation_b",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: process.pid,
    storeVersion: 6, runtimeRoot: "/somewhere/else/generations/0.4.4-c" }));
  await retireManagedHolds({ root, workspaces });
  assert.deepEqual(await readdir(bindings), ["bbbb.json"]);
});

test("a binding naming a relative runtimeRoot is left alone regardless of the caller's cwd", async t => {
  const { root, workspaces, bindings } = await layout(t);
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

test("a binding naming the generations directory itself, not a generation inside it, is left alone", async t => {
  const { root, workspaces, bindings } = await layout(t);
  await writeFile(path.join(bindings, "dddd.json"), JSON.stringify({ schemaVersion: 1,
    harnessSessionId: "h4", accSessionId: "session_d", generation: "generation_d",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: process.pid,
    storeVersion: 6, runtimeRoot: path.join(root, "generations") }));
  await retireManagedHolds({ root, workspaces });
  assert.deepEqual(await readdir(bindings), ["dddd.json"]);
});

test("a runtimeRoot on a different Windows drive than generations is not owned", () => {
  // path.relative returns an absolute path (the literal second argument) when
  // the two roots sit on different Windows drives; POSIX path.relative can
  // never produce that, so this is driven through path.win32 explicitly
  // rather than through the ambient, host-platform path module.
  const generations = "C:\\Users\\acc\\generations";
  const runtimeRoot = "D:\\other\\generations\\0.4.4-c";
  assert.equal(path.win32.relative(generations, runtimeRoot), runtimeRoot,
    "test setup assumption: cross-drive relative degrades to the literal absolute path");
  assert.equal(isOwnedRuntimeRoot(generations, runtimeRoot, path.win32), false);
});
