import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { STORE_VERSION } from "@agents-can-communicate/storage-filesystem";

// The manager reads this field from a staged generation's manifest without
// importing its code. A manifest that drifts from the constant would let an
// incompatible generation pass the activation gate.
test("the package manifest declares the store contract it speaks", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.accStoreVersion, STORE_VERSION);
  assert.equal(typeof manifest.accStoreVersion, "number");
});
