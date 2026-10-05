import assert from "node:assert/strict";
import test from "node:test";
import { EXIT } from "@agents-can-communicate/protocol";
import * as ports from "../src/ports.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";
import { EXACT_NOW, EXACT_WORKSPACE, runExactTransactionContract }
  from "../../../tests/helpers/exact-transaction-contract.mjs";

runExactTransactionContract("memory", async () => createMemoryStore({
  clock: createFakeClock(EXACT_NOW), ids: createFakeIds(), workspaceId: EXACT_WORKSPACE }));

test("exact mode refuses an incompatible custom transaction with a typed error", () => {
  assert.throws(() => ports.assertExactTransaction({ get() {} }), { code: EXIT.USAGE });
  assert.throws(() => ports.assertExactTransaction({ load() {} }), { code: EXIT.USAGE });
});
