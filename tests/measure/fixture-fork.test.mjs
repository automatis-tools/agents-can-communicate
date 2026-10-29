import assert from "node:assert/strict";
import { lstat, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import inbox from "../../scripts/measure/probes/inbox.mjs";
import { fixedIds, openInstance } from "../../scripts/measure/store-fixture.mjs";
import { treeSnapshot } from "../../scripts/tree-snapshot.mjs";

const repo = path.resolve(import.meta.dirname, "../..");

test("forked ID counters retain every kind without sharing subsequent allocations", () => {
  const ids = fixedIds("copy_");
  const kinds = ["generation", "event", "message", "transaction", "session", "future-kind"];
  for (const kind of kinds) { ids.next(kind); ids.next(kind); }
  const first = ids.fork(), second = ids.fork();
  for (const kind of kinds) {
    assert.equal(first.count(kind), 2);
    assert.equal(first.next(kind), ids.nameOf(kind, 3));
    assert.equal(ids.count(kind), 2);
    assert.equal(second.count(kind), 2);
    assert.equal(ids.next(kind), second.next(kind));
    assert.equal(first.next(kind), ids.nameOf(kind, 4));
    assert.equal(ids.count(kind), 3);
  }
});

test("private probe forks preserve real state while isolating ports, expectations and cleanup", async t => {
  const { forkInboxFixture } = await import("../helpers/fork-probe-fixture.mjs");
  const side = await inbox.load(repo);
  const seed = await inbox.build(inbox.scenario({ messages: 2, backlog: 1, operation: "exact", seed: 3 }), side);
  t.after(() => inbox.dispose(seed));
  const roots = new Set();
  t.after(() => Promise.all([...roots].map(root => rm(root, { recursive: true, force: true }))));
  const original = await treeSnapshot(seed.fixture.root);
  const first = await forkInboxFixture(seed); roots.add(first.fixture.root);
  const second = await forkInboxFixture(seed); roots.add(second.fixture.root);
  for (const value of [first, second]) {
    assert.notEqual(value.fixture.root, seed.fixture.root);
    assert.notEqual(value.fixture.store, seed.fixture.store);
    assert.notEqual(value.fixture.service, seed.fixture.service);
    assert.notEqual(value.fixture.ids, seed.fixture.ids);
    assert.notEqual(value.fixture.clock, seed.fixture.clock);
    assert.notEqual(value.side, seed.side);
    assert.deepEqual(await treeSnapshot(value.fixture.root), original);
  }
  const identity = root => stat(path.join(root, "protocol.json"), { bigint: true });
  const a = await identity(first.fixture.root), b = await identity(second.fixture.root), base = await identity(seed.fixture.root);
  assert.notDeepEqual([a.dev, a.ino], [base.dev, base.ino], "a fork must not hardlink seed files");
  assert.notDeepEqual([a.dev, a.ino], [b.dev, b.ino], "forks must not hardlink each other");
  const sibling = await treeSnapshot(second.fixture.root);
  const [receiptId, receipt] = first.receipts.entries().next().value;
  const priorState = receipt.state;
  receipt.state = "fork-only expectation";
  assert.equal(seed.receipts.get(receiptId).state, priorState);
  assert.equal(second.receipts.get(receiptId).state, priorState);
  receipt.state = priorState;
  const input = await inbox.prepare(first), result = await inbox.operate(first, input);
  assert.deepEqual(await inbox.validate(first, result, input), []);
  assert.equal(first.reader[0].state, "retrieved");
  assert.equal(seed.reader[0].state, "queued");
  assert.equal(second.reader[0].state, "queued");
  first.fixture.clock.advance(7000);
  first.fixture.ids.next("fork-probe");
  first.reader[0].subject = "changed expectation";
  first.receipts.values().next().value.state = "changed expectation";
  first.fixture.sessions.reader.generation = "changed_generation";
  first.side.marker = true;
  assert.equal(first.fixture.owner("reader").generation, "changed_generation");
  assert.notEqual(seed.fixture.owner("reader").generation, "changed_generation");
  assert.notEqual(second.fixture.owner("reader").generation, "changed_generation");
  assert.equal(second.fixture.clock.now(), seed.fixture.clock.now());
  assert.notEqual(first.fixture.clock.now(), seed.fixture.clock.now());
  assert.equal(seed.fixture.ids.count("fork-probe"), 0);
  assert.equal(second.fixture.ids.count("fork-probe"), 0);
  assert.equal(seed.side.marker, undefined);
  assert.equal(second.side.marker, undefined);
  const file = path.join(first.fixture.root, "protocol.json");
  await writeFile(file, `${await readFile(file, "utf8")}\n`);
  assert.deepEqual(await treeSnapshot(seed.fixture.root), original);
  assert.deepEqual(await treeSnapshot(second.fixture.root), sibling);
  const firstRoot = first.fixture.root;
  await inbox.dispose(first);
  await assert.rejects(lstat(firstRoot), { code: "ENOENT" });
  assert.ok((await lstat(seed.fixture.root)).isDirectory());
  assert.ok((await lstat(second.fixture.root)).isDirectory());
  await inbox.dispose(second);

  for (const used of [{ ...seed, next: 1 }, { ...seed, target: {} }, { ...seed, generations: 0 }]) {
    await assert.rejects(forkInboxFixture(used), /unused seed/);
  }
  const marker = path.join(seed.fixture.root, "locks", "held.marker");
  await writeFile(marker, "active");
  try { await assert.rejects(forkInboxFixture(seed), /quiescent/); }
  finally { await rm(marker); }
  let failedRoot;
  const failure = new Error("controlled open failure");
  await assert.rejects(forkInboxFixture({ ...seed, side: { ...side,
    openFilesystemStore: async options => { failedRoot = options.root; throw failure; } } }), error => error === failure);
  assert.ok(failedRoot);
  await assert.rejects(lstat(failedRoot), { code: "ENOENT" });
  assert.deepEqual(await treeSnapshot(seed.fixture.root), original);

  const crash = new Error("controlled open journal");
  const pending = await openInstance(seed.fixture, side, { failAt: async point => {
    if (point === "after-journal") throw crash;
  } });
  await assert.rejects(pending.service.readInbox({ ...seed.fixture.owner("reader"),
    messageId: seed.reader[0].messageId }), error => error === crash);
  const unrecovered = await treeSnapshot(seed.fixture.root);
  await assert.rejects(forkInboxFixture(seed), /quiescent seed: open journal/);
  assert.deepEqual(await treeSnapshot(seed.fixture.root), unrecovered, "refusal must not recover the seed");
});
