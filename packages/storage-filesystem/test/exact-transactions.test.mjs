import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EXIT } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "../src/store.mjs";
import { createTransactionView } from "../src/transaction-view.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { EXACT_NOW, EXACT_WORKSPACE, exactMessage, runExactTransactionContract }
  from "../../../tests/helpers/exact-transaction-contract.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-exact-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openFilesystemStore({ root, clock: createFakeClock(EXACT_NOW),
    ids: createFakeIds(), workspaceId: EXACT_WORKSPACE });
}

for (const callbackFails of [false, true]) {
  test(`a rejected read drains a delayed load before another writer enters (${callbackFails ? "callback" : "finish"} error)`, async t => {
    const store = await fixture(t), originalOpen = fs.open;
    await store.transaction(tx => tx.put("message", "message_a", exactMessage()));
    const file = path.join(store.paths.state, "message", "message_a.json");
    const bad = path.join(store.paths.state, "message", "message_bad.json");
    await writeFile(bad, "broken JSON");
    let announce, release, completed = false, secondEntered = false;
    const reading = new Promise(resolve => { announce = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== file) return handle;
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...input) => {
        announce();
        await gate;
        const result = await read(...input);
        completed = true;
        return result;
      };
      return handle;
    };
    syncBuiltinESMExports();
    t.after(() => { release(); fs.open = originalOpen; syncBuiltinESMExports(); });
    const boom = new Error("callback's original error");
    const first = store.transaction(async tx => {
      tx.load("message", "message_a").catch(() => {});
      const failed = tx.load("message", "message_bad");
      failed.catch(() => {});
      if (callbackFails) { await failed.catch(() => {}); throw boom; }
    }, { kinds: ["message"], exactKinds: ["message"] });
    first.catch(() => {});
    await reading;
    const second = store.transaction(() => { secondEntered = true; return completed; }, { kinds: [] });
    second.catch(() => {});
    let enteredBeforeRelease;
    try {
      await Promise.race([second, new Promise(resolve => setTimeout(resolve, 100))]);
      enteredBeforeRelease = secondEntered;
    } finally { release(); }
    await assert.rejects(first, callbackFails ? boom : { code: EXIT.DATA });
    assert.equal(await second, true, "the following writer observes the prior load completed");
    assert.equal(enteredBeforeRelease, false, "a failed sibling read cannot release the mutex early");
  });
}

test("finish drains operations registered by a lookup while it is already draining", async () => {
  let announce, release, completed = false;
  const started = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const boom = new Error("lookup rejected after starting a read");
  const view = createTransactionView({ kinds: ["message"], exactKinds: ["message"],
    loaded: new Map(), loadEnvelope: async () => { announce(); await gate; completed = true; return null; },
    lookupIndex: async (_index, _tuple, context) => {
      await Promise.resolve();
      context.read("message", "message_a").catch(() => {});
      throw boom;
    } });
  view.tx.lookup("messageByClientKey", []).catch(() => {});
  let finished = false;
  const finishing = view.finish().finally(() => { finished = true; });
  finishing.catch(() => {});
  await started;
  await new Promise(resolve => setImmediate(resolve));
  const finishedBeforeRelease = finished;
  release();
  await assert.rejects(finishing, boom);
  assert.equal(completed, true);
  assert.equal(finishedBeforeRelease, false, "newly registered reads remain inside the lifetime fence");
});
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
