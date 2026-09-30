// The managed runtime's launchers may import only their siblings and Node
// built-ins, so they carry their own copy of the store's portable filesystem
// module. Two copies drift silently; this keeps them one file.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the launcher copy of portable-fs is byte-identical to the store's", async () => {
  const store = await readFile(new URL("../packages/storage-filesystem/src/portable-fs.mjs", import.meta.url));
  const launcher = await readFile(new URL("../packages/cli/src/managed-runtime/portable-fs.mjs", import.meta.url));
  assert.equal(launcher.equals(store), true,
    "copy packages/storage-filesystem/src/portable-fs.mjs over the managed-runtime one");
});
