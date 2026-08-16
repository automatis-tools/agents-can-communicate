import { after } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStoreContract } from "../../core/test/service-contract.test.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { openFilesystemStore } from "../src/store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const roots = [];

// The runner owns the lifecycle of each store, so roots are collected and
// removed once rather than wrapped per test.
after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

runStoreContract("filesystem", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acc-store-")));
  roots.push(root);
  return openFilesystemStore({
    root,
    clock: createFakeClock(NOW),
    ids: createFakeIds(),
    workspaceId: "workspace_a",
  });
});
