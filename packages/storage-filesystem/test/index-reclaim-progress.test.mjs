import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openFilesystemStore } from "../src/store.mjs";
import { reclaimIndexPages } from "../src/index-reclaim.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { exactMessage, EXACT_WORKSPACE as WS, EXACT_NOW as NOW }
  from "../../../tests/helpers/exact-transaction-contract.mjs";
import { runProcess } from "../../../tests/helpers/run-process.mjs";
import { createStoreIoProbe } from "../../../tests/helpers/store-io-probe.mjs";

const exact = { kinds: ["message"], exactKinds: ["message"] };
const lookup = (store, key) => store.transaction(
  tx => tx.lookup("messageByClientKey", [WS, "participant_a", key]), exact);
async function fixture(t, count = 600) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-index-progress-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock(NOW), ids = createFakeIds();
  const store = await openFilesystemStore({ root, workspaceId: WS, clock, ids });
  await store.transaction(tx => {
    for (let i = 0; i < count; i++) tx.put("message", `message_${i}`, exactMessage({
      messageId: `message_${i}`, threadId: `message_${i}`, clientMessageId: `client_${i}` }));
  }, { kinds: ["message"] });
  await lookup(store, "client_0");
  return { root, store, directory: path.join(root, "indexes/v1/pages"),
    checkpoint: path.join(root, "indexes/v1/reclaim.json") };
}
async function change(f, key, id = "message_0") {
  await f.store.transaction(async tx => {
    const value = await tx.load("message", id);
    tx.put("message", id, { ...value, clientMessageId: key }, tx.generationOf("message", id));
  }, exact);
}
async function livePages(f) {
  const manifest = JSON.parse(await readFile(path.join(f.root, "indexes/v1/cache.json")));
  const pages = new Map(), pending = Object.values(manifest.roots).filter(Boolean);
  while (pending.length) {
    const hash = pending.pop();
    if (pages.has(hash)) continue;
    const bytes = await readFile(path.join(f.directory, hash + ".json")), page = JSON.parse(bytes);
    pages.set(hash, bytes);
    pending.push(...(page.type === "branch" ? page.children.map(([, child]) => child)
      : page.type === "leaf" ? [...page.entries.map(e => e.ids), page.next].filter(Boolean)
        : [page.next].filter(Boolean)));
  }
  return pages;
}
async function preserve(f, pages) {
  for (const [hash, bytes] of pages) assert.deepEqual(await readFile(path.join(f.directory, hash + ".json")), bytes);
}

test("automatic store opens in fresh processes eventually reclaim a graph larger than one pass", async t => {
  const f = await fixture(t);
  await change(f, "changed");
  const live = await livePages(f), before = await readdir(f.directory);
  assert(live.size > 512, "fixture exceeds the automatic maintenance budget");
  assert(before.length > live.size, "fixture contains real obsolete pages");
  await rm(path.join(f.root, "locks/stage-sweep.json"));
  const script = `import {openFilesystemStore} from ${JSON.stringify(new URL("../src/store.mjs", import.meta.url).href)};
    import {createStoreIoProbe} from ${JSON.stringify(new URL("../../../tests/helpers/store-io-probe.mjs", import.meta.url).href)};
    const root=process.argv[1], probe=createStoreIoProbe(root);
    try {const measured=await probe.capture(()=>openFilesystemStore({root,workspaceId:${JSON.stringify(WS)},
      clock:{now:()=>"2026-08-18T01:00:00.000Z"},ids:{next:()=>{throw Error("unexpected allocation");}}}));
      console.log(JSON.stringify({pageReads:measured.pageReads,indexFlushes:measured.indexFlushes}));}
    finally {probe.stop();}`;
  let finished = false;
  for (let pass = 0; pass < 12; pass++) {
    const child = await runProcess(["--input-type=module", "-e", script, f.root], {
      timeoutMs: 10_000 });
    assert.equal(child.code, 0, child.stderr);
    assert(child.result.pageReads <= 510, "page traversal shares the automatic pass budget");
    assert.equal(child.result.indexFlushes, 0);
    const stamped = await readFile(path.join(f.root, "locks/stage-sweep.json")).then(() => true, () => false);
    if ((await readdir(f.directory)).length === live.size && stamped) { finished = true; break; }
  }
  assert(finished, "automatic passes must finish instead of restarting reachability forever");
  assert.equal((await readdir(f.directory)).length, live.size);
  await preserve(f, live);
  assert.deepEqual(await lookup(f.store, "changed"), ["message_0"]);
  assert.deepEqual(await lookup(f.store, "client_0"), []);
});

test("intervening writers are marked before a paused sweep deletes new reachable pages", async t => {
  const f = await fixture(t, 40);
  await change(f, "first");
  let state;
  for (let pass = 0; pass < 20; pass++) {
    const result = await reclaimIndexPages(f.store.paths, { root: f.root, limit: 16 });
    assert(result.spent <= 16);
    state = JSON.parse(await readFile(f.checkpoint)).state;
    if (state.pending.length === 0 && state.cursor !== null && !state.done) break;
  }
  assert(state.pending.length === 0 && state.cursor !== null && !state.done, "fixture pauses during sweeping");
  await change(f, "second");
  const live = await livePages(f);
  let finished = false;
  for (let pass = 0; pass < 30; pass++) {
    const result = await reclaimIndexPages(f.store.paths, { root: f.root, limit: 16 });
    assert(result.spent <= 16);
    if (!result.remaining) { finished = true; break; }
  }
  assert(finished, "a root change extends marking without restarting the whole cycle");
  await preserve(f, live);
  assert.deepEqual(await lookup(f.store, "second"), ["message_0"]);
  assert.deepEqual(await lookup(f.store, "first"), []);
});

test("damaged or unsafe progress restarts verification and never deletes unverified pages", async t => {
  const f = await fixture(t, 40);
  await change(f, "changed");
  await reclaimIndexPages(f.store.paths, { root: f.root, limit: 16 });
  const before = (await readdir(f.directory)).sort();
  const value = JSON.parse(await readFile(f.checkpoint));
  value.state.pending = [];
  value.state.visited = Object.values(JSON.parse(await readFile(path.join(f.root, "indexes/v1/cache.json"))).roots).filter(Boolean);
  value.state.cursor = null;
  await writeFile(f.checkpoint, JSON.stringify(value));
  const repaired = await reclaimIndexPages(f.store.paths, { root: f.root, limit: 16 });
  assert.equal(repaired.reclaimed, 0);
  assert.deepEqual((await readdir(f.directory)).sort(), before);
  assert(JSON.parse(await readFile(f.checkpoint)).state.pending.length > 0);
  const outside = path.join(f.root, "outside.json"), bytes = await readFile(f.checkpoint);
  await writeFile(outside, bytes);
  await rm(f.checkpoint);
  try { await symlink(outside, f.checkpoint); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") return; throw error; }
  const unsafe = await reclaimIndexPages(f.store.paths, { root: f.root, limit: 16 });
  assert.equal(unsafe.reclaimed, 0);
  assert.deepEqual(await readFile(outside), bytes);
  assert.deepEqual((await readdir(f.directory)).sort(), before);
});

test("progress publication adds no flush and an expired pass cannot delete a live page", async t => {
  const f = await fixture(t, 40), live = await livePages(f);
  await change(f, "changed");
  const probe = createStoreIoProbe(f.root);
  try {
    const measured = await probe.capture(() => reclaimIndexPages(f.store.paths, { root: f.root, limit: 16 }));
    assert.equal(measured.indexFlushes, 0);
    assert(measured.pageReads <= 14, "checkpoint IO shares the page-work budget");
  } finally { probe.stop(); }
  const before = (await readdir(f.directory)).sort();
  const expired = await reclaimIndexPages(f.store.paths, { root: f.root, deadlineAt: Date.now() - 1 });
  assert.equal(expired.reclaimed, 0);
  assert.deepEqual((await readdir(f.directory)).sort(), before);
  await preserve(f, live);
});

test("a lost pending page from an older root cannot permanently block automatic cleanup", async t => {
  const f = await fixture(t, 40);
  await reclaimIndexPages(f.store.paths, { root: f.root, limit: 4 });
  const { pending } = JSON.parse(await readFile(f.checkpoint)).state;
  let stale, key;
  for (const hash of pending) {
    const page = JSON.parse(await readFile(path.join(f.directory, hash + ".json")));
    if (page.type === "leaf") { stale = hash; key = page.entries[0].tuple[2]; break; }
  }
  assert(stale, "fixture pauses with a leaf pending verification");
  const [id] = await lookup(f.store, key);
  await change(f, "changed", id);
  const live = await livePages(f);
  assert(!live.has(stale), "intervening write retires the pending old leaf");
  await rm(path.join(f.directory, stale + ".json"));
  let finished = false;
  for (let pass = 0; pass < 30; pass++) {
    const result = await reclaimIndexPages(f.store.paths, { root: f.root, limit: 16 });
    if (!result.remaining) { finished = true; break; }
  }
  assert(finished, "stale checkpoint references must recover instead of deferring forever");
  await preserve(f, live);
  assert.deepEqual(await lookup(f.store, "changed"), [id]);
});
