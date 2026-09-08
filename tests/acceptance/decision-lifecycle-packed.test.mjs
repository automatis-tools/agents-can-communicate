import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { connectMcp } from "../helpers/mcp-client.mjs";

test("installed CLI and MCP preserve explicit decision changes, forks, and offline delivery", async t => {
  const packed = await createPackedAcc(t);
  const author = await packed.acc(["attach", "--participant", "author"]);
  const reader = await packed.acc(["attach", "--participant", "reader"]);
  const flags = s => ["--session", s.sessionId, "--generation", s.generation];
  const send = (key, extra = []) => packed.acc(["message", ...flags(author),
    "--type", "decision", "--subject", "Port choice", "--body", key,
    "--client-message-id", key, ...extra]);
  const old = (await send("port-7011", ["--to", "reader", "--obligation", "acknowledge"])).message;
  await packed.acc(["detach", ...flags(reader)]);
  const a = (await send("port-7319", ["--supersedes", old.messageId, "--obligation", "acknowledge"])).message;
  assert.deepEqual(a.decisionChange, { action: "replace", messageIds: [old.messageId] });
  assert.deepEqual(a.toParticipantIds, ["reader"]);
  const client = connectMcp({ cwd: packed.project, dataHome: packed.dataHome,
    participant: "peer", binary: packed.mcpBin, env: { GIT_DIR: "", GIT_WORK_TREE: "" } });
  t.after(() => client.close());
  await client.request("initialize", { protocolVersion: "2025-11-25",
    capabilities: {}, clientInfo: { name: "decision-fixture", version: "1.0.0" } });
  client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tool = async (name, args) => {
    const response = await client.request("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined);
    assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
    return JSON.parse(response.result.content[0].text);
  };
  const b = (await tool("acc_message", { to: [], kind: "decision", subject: "Alternative",
    body: "port-8080", obligation: "acknowledge", supersedes: [old.messageId] })).message;
  assert.deepEqual(b.decisionChange, { action: "replace", messageIds: [old.messageId] });
  const heads = await packed.acc(["sync", "--scope", "history", "--type", "decision", "--current"]);
  assert.deepEqual(new Set(heads.items.map(m => m.messageId)), new Set([a.messageId, b.messageId]));
  assert.ok(heads.items.every(m => m.decisionStatus.conflicted));
  assert.doesNotMatch(JSON.stringify(heads), /"body":|"snapshot":/);
  const merge = (await tool("acc_message", { to: [], kind: "decision", subject: "Agreed next choice",
    body: "port-7319", clientMessageId: "merge", supersedes: [a.messageId, b.messageId] })).message;
  const retry = (await tool("acc_message", { to: [], kind: "decision", subject: "Agreed next choice",
    body: "port-7319", clientMessageId: "merge", supersedes: [b.messageId, a.messageId] })).message;
  assert.equal(retry.messageId, merge.messageId);
  const withdrawal = (await send("port-cancelled", ["--withdraws", merge.messageId])).message;
  assert.deepEqual(withdrawal.decisionChange, { action: "withdraw", messageIds: [merge.messageId] });
  const current = await tool("acc_sync", { scope: "history", kind: "decision", current: true });
  assert.deepEqual(current.items.map(m => m.messageId), [withdrawal.messageId]);
  assert.equal(current.items[0].decisionStatus.state, "withdrawn");
  const reopened = await packed.acc(["attach", "--participant", "reader"]);
  const pending = await packed.acc(["inbox", ...flags(reopened)]);
  assert.ok(pending.items.some(i => i.message.messageId === withdrawal.messageId));
  assert.equal(pending.items.some(i => i.message.messageId === old.messageId), false);
  const receipts = (await packed.acc(["sync", "--scope", "full"])).snapshot.receipts;
  assert.equal(receipts.find(r => r.messageId === old.messageId).state, "queued");
  const exact = await tool("acc_sync", { scope: "history", messageId: old.messageId });
  assert.equal(exact.items[0].body, "port-7011");
  assert.equal(exact.items[0].decisionStatus.currentMessageId, withdrawal.messageId);
  const status = await packed.acc(["sync", ...flags(reopened)]);
  assert.equal(status.attention.some(i => i.sourceId === old.messageId), false);
  const before = (await packed.acc(["sync", "--scope", "full"])).snapshot;
  const invalid = await packed.accError(["message", ...flags(author), "--subject", "bad", "--body", "bad",
    "--type", "decision", "--supersedes", old.messageId, "--withdraws", merge.messageId]);
  assert.equal(invalid?.code, 2);
  const invalidMcp = await client.request("tools/call", { name: "acc_message", arguments: {
    to: [], subject: "bad", body: "bad", kind: "note", supersedes: [old.messageId] } });
  assert.equal(invalidMcp.result.isError, true);
  assert.deepEqual((await packed.acc(["sync", "--scope", "full"])).snapshot.messages, before.messages);
  await packed.acc(["detach", ...flags(author)]);
  await packed.acc(["detach", ...flags(reopened)]);
});

test("installed channel text preserves withdrawal links without changing its native envelope", async t => {
  const packed = await createPackedAcc(t);
  const load = (name, file = "index") => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", `${file}.mjs`)));
  const [{ createAccChannel, endpointDir }, { offerMessage }, { projectContextResult }] = await Promise.all([
    load("adapter-claude-code", "channel"), load("adapter-claude-code", "native-delivery"), load("adapter-sdk")]);
  const session = await packed.acc(["attach", "--participant", "author"]);
  const flags = ["--session", session.sessionId, "--generation", session.generation];
  const original = (await packed.acc(["message", ...flags, "--type", "decision",
    "--subject", "Port", "--body", "Use 7011"])).message;
  const changed = (await packed.acc(["message", ...flags, "--type", "decision",
    "--subject", "Port", "--body", "Cancel selection", "--withdraws", original.messageId])).message;
  const current = (await packed.acc(["sync", "--scope", "history", "--message", changed.messageId])).items[0];
  const projected = projectContextResult({ messages: [current], attention: [], roster: [] });
  assert.match(projected.text, new RegExp(`Decision change: withdraw ${original.messageId}`));
  assert.match(projected.text, /Decision status: withdrawn/);
  assert.deepEqual(projected.offeredMessageIds, [changed.messageId]);
  const notifications = [];
  const channel = createAccChannel({ endpointDir: endpointDir(packed.dataHome), clientPid: process.pid,
    write: value => notifications.push(value), routeReply: async () => {}, routeAck: async () => {} });
  t.after(() => channel.close());
  await channel.listen();
  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const result = await offerMessage({ runtimeDir: packed.dataHome,
    binding: { opaqueEndpointRef: channel.endpointId, clientVersion: "2.1.258" }, message: current });
  assert.equal(result.accepted, true);
  const notification = notifications.find(n => n.method === "notifications/claude/channel");
  assert.ok(notification);
  assert.match(notification.params.content, new RegExp(`Decision change: withdraw ${original.messageId}`));
  assert.match(notification.params.content, /Decision status: withdrawn/);
  assert.match(notification.params.content, /untrusted peer content/);
  assert.match(notification.params.content, /Cancel selection/);
  assert.equal(notification.params.meta.message_id, changed.messageId);
  await packed.acc(["detach", ...flags]);
});
