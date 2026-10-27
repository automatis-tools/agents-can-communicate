import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INDEX_DIRECTORY } from "../src/index-io.mjs";

// Missing exports are the initial RED, rather than a broken fixture import.
const optional = specifier => import(specifier).catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const pages = await optional("../src/index-pages.mjs");
const trees = await optional("../src/index-tree.mjs");
const ios = await optional("../src/index-io.mjs");
const definitions = await optional("../../protocol/src/transaction-indexes.mjs");
const tuple = i => ["workspace_a", "participant_a", `client_${i}`];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function memory(digestTuple) {
  assert.equal(typeof trees.createIndexTree, "function", "index tree implementation missing");
  const stored = new Map(), published = [];
  const io = {
    async readPage(hash) {
      if (!stored.has(hash)) throw new pages.IndexCacheUnavailable("missing_page");
      return pages.decodeIndexPage(hash, stored.get(hash));
    },
    async writePage(page) {
      const encoded = pages.encodeIndexPage(page);
      stored.set(encoded.hash, encoded.bytes); published.push({ ...encoded, page });
      return encoded.hash;
    },
  };
  return { ...io, stored, published, tree: trees.createIndexTree({ ...io, digestTuple }) };
}
const add = (tuple, id) => ({ tuple, id, operation: "put" });
function bounded(published) {
  for (const { bytes, page } of published) {
    assert(bytes.length <= 65_536);
    assert((page.entries ?? page.ids ?? page.children).length <= 32);
    assert(!bytes.includes("PRIVATE_MESSAGE_BODY"));
  }
}

test("tree splits without rewriting unaffected pages", async () => {
  const { tree, published } = memory();
  const root = await tree.apply(null, Array.from({ length: 33 }, (_, i) => add(tuple(i), `message_${i}`)));
  assert.deepEqual(await tree.lookup(root, tuple(1)), ["message_1"]);
  const before = published.length;
  const next = await tree.apply(root, [add(tuple(1), "message_second")]);
  assert(published.length - before < 10, "one key must only copy its affected route");
  assert.deepEqual(await tree.lookup(next, tuple(2)), ["message_2"]);
  assert.deepEqual(await tree.lookup(root, tuple(1)), ["message_1"], "old root is immutable");
  bounded(published);
});

test("duplicate keys retain ordered ID groups", async () => {
  const { tree, published } = memory();
  const ids = Array.from({ length: 129 }, (_, i) => `message_${i}`);
  const root = await tree.apply(null, [...ids, ids[0]].map(id => add(tuple(0), id)));
  assert.deepEqual(await tree.lookup(root, tuple(0)), ids.sort((a, b) => a.localeCompare(b)));
  const next = await tree.apply(root, [{ tuple: tuple(0), id: "message_64", operation: "remove" }]);
  assert.deepEqual(await tree.lookup(next, tuple(0)), ids.filter(id => id !== "message_64"));
  // A group of more than 32 IDs branches on their digests; v2 groups never chain.
  assert(published.some(({ page }) => page.type === "branch"));
  assert(!published.some(({ page }) => page.type === "group" && page.next !== null));
  bounded(published);
});

// #306: a pending-receipt group grows with a recipient's unread messages. Each change
// copies the route to its ID, never the pages in front of it in a list.
test("a large ID group changes along its route, not along its length", async () => {
  const { tree, published } = memory();
  const ids = Array.from({ length: 4000 }, (_, i) => `message_${String(i).padStart(5, "0")}`);
  const shuffled = [...ids].sort((a, b) => sha(Buffer.from(a)).localeCompare(sha(Buffer.from(b))));
  const root = await tree.apply(null, shuffled.map(id => add(tuple(0), id)));
  assert.ok(published.length <= 8 * ids.length, `${published.length} pages written for ${ids.length} IDs`);
  assert.deepEqual(await tree.lookup(root, tuple(0)), ids);
  for (const [id, operation] of [["message_new", "put"], ["message_02000", "remove"]]) {
    const before = published.length;
    await tree.apply(root, [{ tuple: tuple(0), id, operation }]);
    assert.ok(published.length - before <= 6, `${published.length - before} pages written to ${operation} one ID`);
  }
  bounded(published);
});

test("full digest collisions remain separate", async () => {
  const { tree, published } = memory(() => "f".repeat(64));
  const root = await tree.apply(null, Array.from({ length: 33 }, (_, i) => add(tuple(i), `message_${i}`)));
  for (let i = 0; i < 33; i += 1) assert.deepEqual(await tree.lookup(root, tuple(i)), [`message_${i}`]);
  assert.deepEqual(await tree.lookup(root, tuple(100)), []);
  bounded(published);
});

test("invalid referenced pages cannot answer absent", async () => {
  const { tree, writePage } = memory();
  const hash = sha(Buffer.from(JSON.stringify(tuple(0))));
  const root = await writePage({ type: "branch", children: [[hash[0], "a".repeat(64)]] });
  await assert.rejects(tree.lookup(root, tuple(0)), pages.IndexCacheUnavailable);
  assert.deepEqual(await tree.lookup(root, tuple(1)), []);
  const invalid = [
    Buffer.from('{ "type": "group", "ids": [], "next": null }\n'),
    Buffer.from(JSON.stringify({ type: "branch", children: [["a", "b".repeat(64)], ["a", "c".repeat(64)]] }) + "\n"),
    Buffer.from(JSON.stringify({ type: "group", ids: ["message_a"], next: "../outside" }) + "\n"),
    Buffer.alloc(65_537, 32),
  ];
  for (const bytes of invalid) assert.throws(() => pages.decodeIndexPage(sha(bytes), bytes), pages.IndexCacheUnavailable);
  const good = pages.encodeIndexPage({ type: "group", ids: ["message_a"], next: null });
  assert.throws(() => pages.decodeIndexPage("0".repeat(64), good.bytes), pages.IndexCacheUnavailable);
});

test("closed index definitions preserve tuple boundaries and exclude bodies", () => {
  assert.equal(typeof definitions.assertIndexTuple, "function", "index definitions missing");
  assert.deepEqual(definitions.assertIndexTuple("messageByClientKey", tuple(0)), tuple(0));
  for (const [index, key] of [["unknown", tuple(0)], ["messageByClientKey", ["workspace_a"]],
    ["receiptsByMessage", ["workspace_a", "../message"]]]) {
    assert.throws(() => definitions.assertIndexTuple(index, key));
  }
  assert.deepEqual(definitions.indexKeysFor("message", { workspaceId: "workspace_a", kind: "note",
    fromParticipantId: "participant_a", clientMessageId: "client_0", body: "PRIVATE_MESSAGE_BODY" }),
  [{ index: "messageByClientKey", tuple: tuple(0) }]);
  // A decision is keyed once for each decision it replaces.
  assert.deepEqual(definitions.indexKeysFor("message", { workspaceId: "workspace_a", kind: "decision",
    fromParticipantId: "participant_a", clientMessageId: "client_0",
    decisionChange: { action: "replace", messageIds: ["message_a", "message_b"] } }),
  [{ index: "messageByClientKey", tuple: tuple(0) }, { index: "decisionsByTarget", tuple: ["workspace_a", "message_a"] },
    { index: "decisionsByTarget", tuple: ["workspace_a", "message_b"] }]);
  const receipt = (state, obligation) => definitions.indexKeysFor("receipt", { workspaceId: "workspace_a",
    messageId: "message_a", recipientParticipantId: "participant_b", state,
    ...(obligation === undefined ? {} : { extensions: { obligation } }) }).map(key => key.index);
  assert.deepEqual(receipt("queued", "none"), ["receiptsByMessage", "receiptsByRecipientState"]);
  // What can no longer be listed is left out; a receipt without its obligation is kept.
  assert.deepEqual(receipt("acknowledged", "reply"), ["receiptsByMessage"]);
  assert.deepEqual(receipt("retrieved", "none"), ["receiptsByMessage"]);
  assert.deepEqual(receipt("retrieved", "reply"), ["receiptsByMessage", "receiptsByRecipientState"]);
  assert.deepEqual(receipt("retrieved"), ["receiptsByMessage", "receiptsByRecipientState"]);
  assert.deepEqual(definitions.indexKeysFor("session", {}), []);
});

test("real filesystem pages publish safely without flushing or following junctions", async t => {
  assert.equal(typeof ios.createIndexIO, "function", "safe index IO missing");
  const root = await mkdtemp(path.join(tmpdir(), "acc-index-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { tmp: path.join(root, "tmp"), stage: path.join(root, "stage") };
  let flushes = 0;
  const io = ios.createIndexIO({ root, paths, publishOptions: {
    root, tmpDir: paths.tmp, stageDir: paths.stage, sync() { flushes += 1; },
  } });
  const tree = trees.createIndexTree(io);
  const head = await tree.apply(null, [add(tuple(0), "message_a")]);
  const manifest = { indexVersion: ios.INDEX_VERSION, workspaceId: "workspace_a", journalGeneration: "0000000000000000",
    roots: { decisionsByTarget: null, messageByClientKey: head, receiptsByMessage: null, receiptsByRecipientState: null } };
  await io.writeManifest(manifest);
  assert.deepEqual(await io.readManifest(), manifest);
  assert.deepEqual(await tree.lookup(head, tuple(0)), ["message_a"]);
  assert.equal(flushes, 0);
  const bytes = await readFile(path.join(root, INDEX_DIRECTORY, "pages", head + ".json"));
  assert.equal(sha(bytes), head);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await rm(path.join(root, INDEX_DIRECTORY, "pages"), { recursive: true });
  await symlink(outside, path.join(root, INDEX_DIRECTORY, "pages"), "junction");
  await assert.rejects(io.readPage(head), pages.IndexCacheUnavailable);
  await assert.rejects(io.writePage({ type: "group", ids: ["message_escape"], next: null }), pages.IndexCacheUnavailable);
});
