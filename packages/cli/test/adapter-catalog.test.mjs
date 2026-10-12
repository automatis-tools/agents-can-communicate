import assert from "node:assert/strict";
import test from "node:test";

import { ADAPTER_IDS, loadAdapter, loadAdapters } from "../src/adapter-catalog.mjs";
import { ALL_ADAPTERS } from "../src/install-command.mjs";

// Install and doctor serve every client and load them all at once; everything
// else loads one by id (#270). An adapter named in one list and not the other
// would install a client its hooks and indicator cannot run.
test("the catalog names every adapter install serves, under its own id", async () => {
  assert.deepEqual([...ADAPTER_IDS].sort(), ALL_ADAPTERS().map(adapter => adapter.id).sort());
  for (const adapterId of ADAPTER_IDS) assert.equal((await loadAdapter(adapterId)).id, adapterId);
});

test("an id no adapter has loads nothing", async () => {
  assert.equal(await loadAdapter("cli"), null);
  assert.equal(await loadAdapter("__proto__"), null);
  assert.deepEqual(Object.keys(await loadAdapters(["codex", "cli", "codex", undefined])), ["codex"]);
});
