import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";

// Fixture setup owns the hook payload and runtime. Supply its exact credentials
// explicitly when testing claims, receipts, etc. This is NOT a client ownership
// resolver and must never be used to claim an ordinary shell can identify itself.
export async function fixtureOwnerEnv(dataHome, harnessSessionId) {
  const workspaces = path.join(dataHome, "acc", "workspaces");
  const found = [];
  for (const workspace of await readdir(workspaces)) {
    const binding = await loadSessionBinding({ runtimeDir: path.join(workspaces, workspace),
      harnessSessionId });
    if (binding !== null) found.push(binding);
  }
  assert.equal(found.length, 1, `fixture must own exactly one binding for ${harnessSessionId}`);
  assert.equal(typeof found[0].generation, "string");
  return { ACC_SESSION: found[0].accSessionId, ACC_GENERATION: found[0].generation };
}
