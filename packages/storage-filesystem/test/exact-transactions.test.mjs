import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EXIT } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "../src/store.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { EXACT_NOW, EXACT_WORKSPACE, exactMessage, runExactTransactionContract }
  from "../../../tests/helpers/exact-transaction-contract.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-exact-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openFilesystemStore({ root, clock: createFakeClock(EXACT_NOW),
    ids: createFakeIds(), workspaceId: EXACT_WORKSPACE });
}
runExactTransactionContract("filesystem", fixture);

for (const fault of ["binding", "workspace", "symlink"]) {
  test(`exact reads retain ${fault} validation`, async t => {
    const store = await fixture(t);
    await store.transaction(tx => tx.put("message", "message_a", exactMessage()));
    const file = path.join(store.paths.state, "message", "message_a.json");
    const envelope = JSON.parse(await readFile(file, "utf8"));
    if (fault === "binding") envelope.id = "message_other";
    if (fault === "workspace") envelope.record.workspaceId = "workspace_other";
    if (fault === "symlink") {
      const kind = path.dirname(file), outside = path.join(store.root, "other-records");
      await rename(kind, outside);
      await symlink(outside, kind, "junction");
    } else await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(store.transaction(tx => tx.load("message", "message_a"),
      { kinds: ["message"], exactKinds: ["message"] }), { code: EXIT.DATA });
  });
}
