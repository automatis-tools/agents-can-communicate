import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { connectMcp } from "../helpers/mcp-client.mjs";

async function fixture(t) {
  const packed = await createPackedAcc(t);
  const load = name => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", "index.mjs")));
  const [{ createCoordinationService }, { openFilesystemStore }, { createId },
    { discoverWorkspace, createGitProbe, runtimePaths }] = await Promise.all(
    ["core", "storage-filesystem", "protocol", "cli"].map(load));
  const descriptor = await discoverWorkspace({ cwd: packed.project, env: packed.env,
    gitProbe: createGitProbe({ env: packed.env }) });
  let time = Date.parse("2026-08-01T12:00:00.000Z");
  const clock = { now: () => new Date(time).toISOString() };
  const ids = { next: kind => createId(kind, randomBytes) };
  const paths = runtimePaths({ dataHome: packed.dataHome, workspaceId: descriptor.id,
    workspaceRoots: descriptor.roots });
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: descriptor.id });
  const service = createCoordinationService({ store, clock, ids });
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  const open = participantId => service.openSession({ participantId, harness: "cli",
    heartbeatCadenceMs: 30_000, descriptor, workspaceId: descriptor.id });
  const sender = await open("sender"), reader = await open("reader");
  const mcp = await open("mcp-reader");
  const messages = [];
  for (let i = 0; i < 60; i += 1) {
    time += 1_000;
    messages.push(await service.sendMessage({ ...owner(sender), clientMessageId: `old-${i}`,
      toParticipantIds: ["reader", "mcp-reader"], kind: "note", obligation: "none",
      subject: `Earlier finding ${i}`, body: `HISTORICAL_BODY_${i}: ${"x".repeat(3_000)}` }));
  }
  for (const session of [sender, reader, mcp]) await service.closeSession(owner(session));
  const current = await packed.acc(["attach", "--participant", "reader"]);
  const flags = ["--session", current.sessionId, "--generation", current.generation];
  const snapshot = async () => (await packed.acc(["sync", "--scope", "full"])).snapshot;
  return { packed, messages, flags, snapshot };
}

test("installed inbox discovers pages without retrieving their bodies or skipping a read anchor", async t => {
  const { packed, messages, flags, snapshot } = await fixture(t);
  const before = await snapshot();
  const first = await packed.acc(["inbox", ...flags]);
  assert.equal(Array.isArray(first), false, "default inbox still dumps and retrieves the whole queue");
  assert.ok(first.items.length > 0 && first.items.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(first, null, 2)) <= 12_000);
  assert.doesNotMatch(JSON.stringify(first), /HISTORICAL_BODY_|"body":/);
  assert.deepEqual((await snapshot()).receipts, before.receipts);
  for (const control of [["--limit", "1"], ["--cursor", first.nextCursor]]) {
    const denied = await packed.accError(["inbox", ...flags,
      "--message", messages[59].messageId, ...control]);
    assert.equal(denied?.code, 2, "an exact inbox read accepted list controls");
  }
  assert.deepEqual((await snapshot()).receipts, before.receipts);
  const collected = first.items.map(item => item.message.messageId);
  assert.equal(collected[0], messages[59].messageId, "discovery must show the newest message first");

  // Reading the anchor removes this note from pending mail; an offset cursor
  // would skip its neighbour on the next page.
  const [read] = await packed.acc(["inbox", ...flags, "--message", first.nextCursor]);
  assert.equal(read.message.body, messages.find(item => item.messageId === first.nextCursor).body);
  assert.equal(read.receipt.state, "retrieved");
  const late = await packed.acc(["attach", "--participant", "sender"]);
  const fresh = await packed.acc(["message", "--session", late.sessionId,
    "--generation", late.generation, "--to", "reader", "--subject", "New arrival",
    "--body", "CURRENT_BODY: arrived after the first page"]);
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const page = await packed.acc(["inbox", ...flags, "--cursor", cursor, "--limit", "7"]);
    assert.ok(page.items.length <= 7);
    assert.doesNotMatch(JSON.stringify(page), /HISTORICAL_BODY_|CURRENT_BODY/);
    collected.push(...page.items.map(item => item.message.messageId));
    cursor = page.nextCursor;
    assert.ok(collected.length <= 60, "pagination replayed a page");
  }
  assert.deepEqual(collected, messages.map(item => item.messageId).reverse());
  const again = await packed.acc(["inbox", ...flags]);
  assert.equal(again.items[0].message.messageId, fresh.message.messageId);
  const oldReceipts = (await snapshot()).receipts.filter(item =>
    messages.some(message => message.messageId === item.messageId));
  assert.equal(oldReceipts.filter(item => item.state === "retrieved").length, 1);
  assert.equal(oldReceipts.filter(item => item.state === "queued").length, 119);
});

test("installed MCP discovery and public history offer exact reads without a workspace body dump", async t => {
  const { packed, messages, snapshot } = await fixture(t);
  const client = connectMcp({ cwd: packed.project, dataHome: packed.dataHome,
    participant: "mcp-reader", binary: packed.mcpBin, env: { GIT_DIR: "", GIT_WORK_TREE: "" } });
  t.after(() => client.close());
  await client.request("initialize", { protocolVersion: "2025-11-25",
    capabilities: {}, clientInfo: { name: "bounded-read-fixture", version: "1.0.0" } });
  client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0",
    method: "notifications/initialized" }) + "\n");
  const tool = async (name, args = {}) => {
    const response = await client.request("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined);
    assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
    return JSON.parse(response.result.content[0].text);
  };
  const before = await snapshot();
  const listed = await tool("acc_inbox", { limit: 3 });
  assert.equal(listed.items.length, 3);
  assert.doesNotMatch(JSON.stringify(listed), /HISTORICAL_BODY_|"body":/);
  const next = await tool("acc_inbox", { cursor: listed.nextCursor, limit: 3 });
  assert.equal(next.items[0].message.messageId, messages[56].messageId);
  const resource = await client.request("resources/read", { uri: "acc://inbox" });
  assert.equal(resource.error, undefined);
  const resourcePage = JSON.parse(resource.result.contents[0].text);
  assert.ok(resourcePage.items.length <= 20 && resourcePage.nextCursor);
  assert.doesNotMatch(JSON.stringify(resourcePage), /HISTORICAL_BODY_|"body":/);
  assert.deepEqual((await snapshot()).receipts, before.receipts);
  for (const control of [{ limit: 1 }, { cursor: listed.nextCursor }]) {
    const denied = await client.request("tools/call", { name: "acc_inbox",
      arguments: { messageId: messages[59].messageId, ...control } });
    assert.equal(denied.result.isError, true, "an exact MCP inbox read accepted list controls");
  }
  assert.deepEqual((await snapshot()).receipts, before.receipts);
  const [read] = await tool("acc_inbox", { messageId: messages[59].messageId });
  assert.equal(read.message.body, messages[59].body);
  assert.equal(read.receipt.state, "retrieved");

  const history = await packed.acc(["sync", "--scope", "history", "--type", "note", "--limit", "1"]);
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].messageId, messages[59].messageId);
  assert.doesNotMatch(JSON.stringify(history), /HISTORICAL_BODY_|"snapshot":/);
  const older = await tool("acc_sync", { scope: "history", kind: "note", limit: 1,
    cursor: history.nextCursor });
  assert.equal(older.items[0].messageId, messages[58].messageId);
  const receiptBeforeHistoryRead = (await snapshot()).receipts;
  const exact = await tool("acc_sync", { scope: "history", messageId: messages[58].messageId });
  assert.equal(exact.items[0].body, messages[58].body);
  assert.deepEqual((await snapshot()).receipts, receiptBeforeHistoryRead);
});
