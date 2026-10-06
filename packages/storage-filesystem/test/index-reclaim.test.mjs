import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";
import { readActiveJournal } from "../src/active-journal.mjs";
import { openFilesystemStore } from "../src/store.mjs";
import { createIndexIO } from "../src/index-io.mjs";
import { reclaimRetired } from "../src/reclaim.mjs";
import { createStoreIoProbe } from "../../../tests/helpers/store-io-probe.mjs";
import { runProcess } from "../../../tests/helpers/run-process.mjs";
import { processFixtureEnv } from "../../../tests/helpers/process-env.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { exactMessage, EXACT_WORKSPACE as WS, EXACT_NOW as NOW }
  from "../../../tests/helpers/exact-transaction-contract.mjs";

const exact = { kinds: ["message", "receipt"], exactKinds: ["message", "receipt"] };
const lookup = (store, client = "client_a") => store.transaction(
  tx => tx.lookup("messageByClientKey", [WS, "participant_a", client]), exact);
async function fixture(t, failAt) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-index-reclaim-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = createFakeClock(NOW), ids = createFakeIds();
  const store = await openFilesystemStore({ root, workspaceId: WS, clock, ids, failAt });
  await store.transaction(tx => {
    for (const suffix of ["a", "b"]) {
      const id = `message_${suffix}`;
      tx.put("message", id, exactMessage({ messageId: id, threadId: id, clientMessageId: `client_${suffix}` }));
      tx.put("receipt", `receipt_${suffix}`, { schemaVersion: SCHEMA_VERSION, workspaceId: WS,
        messageId: id, recipientParticipantId: "participant_a", state: "queued", updatedAt: NOW });
    }
  }, { kinds: ["message", "receipt"] });
  await lookup(store);
  return { root, store, clock, ids, manifest: path.join(root, "indexes/v1/cache.json") };
}

test("indexed prune fences a bounded prefix, permits key reuse and preserves surviving receipts", async t => {
  const f = await fixture(t);
  const entries = await f.store.stateEnvelopes(WS, { kinds: ["receipt", "message"] });
  const plan = [entries.find(e => e.id === "receipt_a"), entries.find(e => e.id === "message_a")];
  const before = await readActiveJournal(f.store.paths, f.root);
  await f.store.reclaimRecords(plan, { limit: 4 });
  const after = await readActiveJournal(f.store.paths, f.root);
  assert.equal(after.state, "idle");
  assert.notEqual(after.generation, before.generation);
  await assert.rejects(readFile(f.manifest), { code: "ENOENT" }, "explicit prune discards its invalidated cache");
  assert.deepEqual(await lookup(f.store), []);
  assert.deepEqual(await lookup(f.store, "client_b"), ["message_b"]);
  assert.deepEqual(await f.store.transaction(tx => tx.lookup("receiptsByMessage", [WS, "message_a"]), exact), []);
  assert.deepEqual(await f.store.transaction(tx => tx.lookup("receiptsByMessage", [WS, "message_b"]), exact), ["receipt_b"]);
  await f.store.transaction(tx => tx.put("message", "message_reused", exactMessage({
    messageId: "message_reused", threadId: "message_reused" })), { kinds: ["message"] });
  assert.deepEqual(await lookup(f.store), ["message_reused"]);
});

test("a restored primary filename cannot make the old negative cache current after prune", async t => {
  const f = await fixture(t), file = path.join(f.root, "state/message/message_a.json");
  const bytes = await readFile(file), envelope = JSON.parse(bytes);
  await f.store.transaction(tx => tx.remove("message", "message_a",
    tx.generationOf("message", "message_a")), { kinds: ["message"] });
  assert.deepEqual(await lookup(f.store), []);
  const before = await readActiveJournal(f.store.paths, f.root);
  await f.store.reclaimRecords([envelope]);
  assert.notEqual((await readActiveJournal(f.store.paths, f.root)).generation, before.generation);
  // A simulated partial filesystem rollback restores the primary, without its
  // deletion markers, before any new cache is checkpointed.
  await writeFile(file, bytes);
  const reopened = await openFilesystemStore({ root: f.root, workspaceId: WS, clock: f.clock, ids: f.ids });
  assert.deepEqual(await lookup(reopened), ["message_a"]);
});

test("bounded reachability visits delete nothing until every current root is verified", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) await f.store.transaction(async tx => {
    const message = await tx.load("message", "message_a");
    tx.put("message", "message_a", { ...message, clientMessageId: `client_${i}` },
      tx.generationOf("message", "message_a"));
  }, exact);
  const directory = path.join(f.root, "indexes/v1/pages"), before = (await readdir(directory)).sort();
  const { reclaimIndexPages } = await import("../src/index-reclaim.mjs");
  const io = createIndexIO({ paths: f.store.paths, root: f.root, publishOptions: {} });
  const manifest = await io.readManifest();
  const reachable = new Map(), pending = Object.values(manifest.roots).filter(Boolean);
  while (pending.length > 0) {
    const hash = pending.pop();
    if (reachable.has(hash)) continue;
    const page = await io.readPage(hash);
    reachable.set(hash, await readFile(path.join(directory, hash + ".json")));
    pending.push(...(page.type === "branch" ? page.children.map(([, child]) => child)
      : page.type === "leaf" ? [...page.entries.map(e => e.ids), page.next].filter(Boolean)
        : [page.next].filter(Boolean)));
  }
  const limited = await reclaimIndexPages(f.store.paths, { root: f.root, roots: manifest.roots, limit: 1 });
  assert.equal(limited.reclaimed, 0);
  assert.equal(limited.remaining, true);
  assert.deepEqual((await readdir(directory)).sort(), before);
  const complete = await reclaimIndexPages(f.store.paths, { root: f.root, roots: manifest.roots, limit: 128 });
  assert(complete.reclaimed > 0, "unreachable pages actually leave the store");
  assert((await readdir(directory)).length < before.length);
  for (const [hash, bytes] of reachable) assert.deepEqual(await readFile(path.join(directory, hash + ".json")), bytes);
  assert.deepEqual(await lookup(f.store, "client_3"), ["message_a"]);
  assert.deepEqual(await lookup(f.store, "client_b"), ["message_b"]);
});

test("an unverified referenced page suppresses all unreachable-page deletion", async t => {
  const f = await fixture(t);
  const { reclaimIndexPages } = await import("../src/index-reclaim.mjs");
  const manifest = JSON.parse(await readFile(f.manifest));
  const directory = path.join(f.root, "indexes/v1/pages"), before = (await readdir(directory)).sort();
  await writeFile(path.join(directory, manifest.roots.messageByClientKey + ".json"), "broken cache page");
  const result = await reclaimIndexPages(f.store.paths, { root: f.root, roots: manifest.roots, limit: 128 });
  assert.equal(result.reclaimed, 0);
  assert.equal(result.remaining, true);
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test("maintenance defers a graph larger than its remaining budget until the next daily pass", async t => {
  const f = await fixture(t);
  const result = await reclaimRetired(f.store.paths, { root: f.root, limit: 4 });
  assert.equal(result.remaining, false, "an unfinishable cache traversal must not force a sweep on every hook");
  assert.deepEqual(await lookup(f.store), ["message_a"]);
});

test("trimming every event leaves surviving retry lookup complete", async t => {
  const f = await fixture(t);
  await f.store.transaction(tx => tx.append({ schemaVersion: SCHEMA_VERSION,
    eventId: "event_trimmed", workspaceId: WS, actorSessionId: "session_a",
    type: "message.recorded", occurredAt: NOW, payload: {} }), { kinds: [] });
  const events = await f.store.eventsSince(WS, null, 100);
  await f.store.trimHistory(events.cursor);
  assert.equal((await f.store.eventsSince(WS, null, 100)).events.length, 0);
  assert.deepEqual(await lookup(f.store), ["message_a"]);
  assert.deepEqual(await lookup(f.store, "client_b"), ["message_b"]);
});

test("an applied prune prefix is flushed before idle even when its operation deadline lapses", async t => {
  let expiredAt, moved = false;
  const now = Date.now;
  t.after(() => { Date.now = now; });
  const f = await fixture(t, async phase => {
    if (phase === "after-indexed-prune-move" && !moved) {
      moved = true;
      Date.now = () => expiredAt + 1;
    }
  });
  const entries = await f.store.stateEnvelopes(WS, { kinds: ["message"] });
  const probe = createStoreIoProbe(f.root, { trace: true });
  t.after(() => probe.stop());
  expiredAt = now() + 30_000;
  let measured;
  try { measured = await probe.capture(() => f.store.reclaimRecords(entries, { deadlineAt: expiredAt })); }
  finally { Date.now = now; }
  assert.equal(moved, true);
  assert.equal(measured.result.remaining, true);
  const rename = measured.trace.findIndex(e => e.operation === "rename" && e.from === path.join("state", "message", "message_a.json"));
  const idle = measured.trace.findLastIndex(e => e.operation === "rename" && /^journal[/\\]active\.[01]$/.test(e.to));
  assert(rename >= 0 && idle > rename);
  if (process.platform !== "win32") {
    const flush = measured.trace.findIndex((e, i) => i > rename && e.operation === "sync" && e.file === path.join("state", "message"));
    assert(flush > rename && idle > flush, "POSIX primary-directory sync precedes the idle publication");
  }
  assert.equal((await readActiveJournal(f.store.paths, f.root)).state, "idle");
});

test("interruptions at prune phases recover with invalidated roots", async t => {
  for (const interruptedPhase of ["after-indexed-prune-activated", "after-indexed-prune-move", "before-indexed-prune-idle"]) {
    let enabled = false;
    const f = await fixture(t, phase => { if (enabled && phase === interruptedPhase) throw new Error(phase); });
    const [entry] = await f.store.stateEnvelopes(WS, { kinds: ["message"] });
    const before = await readActiveJournal(f.store.paths, f.root);
    enabled = true;
    await assert.rejects(f.store.reclaimRecords([entry]), { message: interruptedPhase });
    enabled = false;
    const reopened = await openFilesystemStore({ root: f.root, workspaceId: WS, clock: f.clock, ids: f.ids });
    assert.notEqual((await readActiveJournal(reopened.paths, f.root)).generation, before.generation);
    assert.deepEqual(await lookup(reopened), interruptedPhase === "after-indexed-prune-activated" ? ["message_a"] : []);
    assert.deepEqual(await lookup(reopened, "client_b"), ["message_b"]);
  }
});

for (const withMarker of [false, true]) test(`process-exit prune recovery flushes primary retirement before idle and negative-cache publication (${withMarker ? "marker" : "record"} move)`, async t => {
  const f = await fixture(t);
  const entry = (await f.store.stateEnvelopes(WS, { kinds: ["message"] })).find(e => e.id === "message_a");
  if (withMarker) await f.store.transaction(tx => tx.remove("message", entry.id,
    tx.generationOf("message", entry.id)), { kinds: ["message"] });
  const script = `
    import { randomUUID } from "node:crypto";
    import { openFilesystemStore } from ${JSON.stringify(new URL("../src/store.mjs", import.meta.url).href)};
    import { createFakeClock } from ${JSON.stringify(new URL("../../../tests/helpers/memory-store.mjs", import.meta.url).href)};
    let moves = 0;
    const store = await openFilesystemStore({ root: process.argv[1], workspaceId: ${JSON.stringify(WS)},
      clock: createFakeClock(${JSON.stringify(NOW)}), ids: { next: kind => kind + "_" + randomUUID() },
      failAt: phase => { if (phase === "after-indexed-prune-move" && ++moves === ${withMarker ? 2 : 1}) process.exit(91); } });
    await store.reclaimRecords([JSON.parse(process.argv[2])]);
  `;
  const child = await runProcess(["--input-type=module", "-e", script, f.root, JSON.stringify(entry)],
    { timeoutMs: 10_000, env: await processFixtureEnv(path.join(f.root, "child-env")) });
  assert.equal(child.code, 91, child.stderr);
  assert.equal((await readActiveJournal(f.store.paths, f.root)).state, "open");
  const probe = createStoreIoProbe(f.root, { trace: true });
  t.after(() => probe.stop());
  const measured = await probe.capture(async () => {
    const reopened = await openFilesystemStore({ root: f.root, workspaceId: WS, clock: f.clock, ids: f.ids });
    return lookup(reopened);
  });
  assert.deepEqual(measured.result, []);
  const idle = measured.trace.findIndex(e => e.operation === "rename" && /^journal[/\\]active\.[01]$/.test(e.to));
  const cache = measured.trace.findIndex(e => e.operation === "rename" && e.to === path.join("indexes", "v1", "cache.json"));
  assert(idle >= 0 && cache > idle, "recovery is completed before the negative cache is checkpointed");
  if (process.platform !== "win32") {
    const flush = measured.trace.findIndex(e => e.operation === "sync" && e.file === path.join("state", "message"));
    assert(flush >= 0 && flush < idle, "POSIX primary-directory flush precedes recovered idle");
    if (withMarker) {
      const markerFlush = measured.trace.findIndex(e => e.operation === "sync"
        && e.file === path.join("retained", "state", "message"));
      assert(markerFlush >= 0 && markerFlush < idle, "retired marker names are durable before recovered idle");
    }
  }
});
