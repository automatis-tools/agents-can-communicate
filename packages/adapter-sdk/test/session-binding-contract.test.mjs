import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { storeSessionBinding } from "../src/session-binding.mjs";
import { fixtureRoot } from "../../../tests/helpers/temp-workspace.mjs";

const bindingFile = (runtimeDir, harnessSessionId) => path.join(runtimeDir, "bindings",
  `${createHash("sha256").update(harnessSessionId).digest("hex").slice(0, 32)}.json`);

test("a published binding declares the contract and generation that wrote it", async t => {
  const runtimeDir = await fixtureRoot(t, "acc-binding-");
  await storeSessionBinding({ runtimeDir, harnessSessionId: "harness-1",
    accSessionId: "session_aaaaaaaaaaaaaaaaaaaaaa", generation: "generation_bbbbbbbbbbbbbbbbbbbbbb",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: 4242,
    storeVersion: 6, runtimeRoot: "/generations/0.4.4-abc" });
  const record = JSON.parse(await readFile(bindingFile(runtimeDir, "harness-1"), "utf8"));
  assert.equal(record.storeVersion, 6);
  assert.equal(record.runtimeRoot, "/generations/0.4.4-abc");
  // The session generation must keep its own meaning.
  assert.equal(record.generation, "generation_bbbbbbbbbbbbbbbbbbbbbb");
});

test("a binding written without the contract stays readable", async t => {
  const runtimeDir = await fixtureRoot(t, "acc-binding-");
  await storeSessionBinding({ runtimeDir, harnessSessionId: "harness-2",
    accSessionId: "session_aaaaaaaaaaaaaaaaaaaaaa", generation: "generation_bbbbbbbbbbbbbbbbbbbbbb",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: 4243 });
  const record = JSON.parse(await readFile(bindingFile(runtimeDir, "harness-2"), "utf8"));
  assert.equal(record.storeVersion, undefined);
  assert.equal(record.clientPid, 4243);
});
