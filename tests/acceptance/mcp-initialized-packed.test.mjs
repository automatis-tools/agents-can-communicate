import assert from "node:assert/strict";
import test from "node:test";

import { connectMcp } from "../helpers/mcp-client.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

// These are protocol peers, not simulated vendor clients. Real-client evidence
// lives in the MCP compatibility record; this gate exercises the shipped binary.
test("installed initialized peers exchange and acknowledge linked replies", async t => {
  const packed = await createPackedAcc(t);
  async function peer(participant, protocolVersion) {
    const client = connectMcp({ cwd: packed.project, dataHome: packed.dataHome,
      participant, binary: packed.mcpBin, env: { GIT_DIR: "", GIT_WORK_TREE: "" } });
    t.after(() => client.close());
    const opened = await client.request("initialize", { protocolVersion,
      capabilities: {}, clientInfo: { name: "protocol-fixture", version: "1.0.0" } });
    assert.equal(opened.error, undefined, JSON.stringify(opened.error));
    assert.equal(opened.result.protocolVersion, protocolVersion);
    client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0",
      method: "notifications/initialized" }) + "\n");
    const tools = await client.request("tools/list", {});
    assert.equal(tools.result.tools.some(tool => tool.name === "acc_reply"), true);
    return async (name, args = {}) => {
      const response = await client.request("tools/call", { name, arguments: args });
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
      if (Object.hasOwn(response.result, "structuredContent")) {
        assert.equal(typeof response.result.structuredContent, "object");
        assert.notEqual(response.result.structuredContent, null);
        assert.equal(Array.isArray(response.result.structuredContent), false,
          "2025 clients reject array structuredContent before exposing inbox data");
      }
      return JSON.parse(response.result.content[0].text);
    };
  }
  const author = await peer("author", "2025-06-18");
  const reviewer = await peer("reviewer", "2025-11-25");
  await reviewer("acc_work", { summary: "reviewing pagination", mode: "review" });
  const sent = await author("acc_request", { toParticipantId: "reviewer",
    title: "Check pagination", detail: "Does a nonzero offset still return limit items?" });
  assert.equal(sent.message.fromParticipantId, "author");
  const listed = await reviewer("acc_inbox");
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].message.body, undefined);
  const received = await reviewer("acc_inbox", { messageId: listed.items[0].message.messageId });
  assert.equal(received.length, 1);
  assert.equal(received[0].message.messageId, sent.message.messageId);
  assert.equal(received[0].message.body, "Does a nonzero offset still return limit items?");
  const receipt = async () => (await author("acc_sync", { scope: "full" }))
    .snapshot.receipts.find(item => item.messageId === sent.message.messageId);
  assert.equal((await receipt()).state, "retrieved");

  const reply = await reviewer("acc_reply", { messageId: sent.message.messageId,
    body: "No. slice expects an end index; use offset + limit." });
  assert.equal(reply.message.inReplyTo, sent.message.messageId);
  assert.equal(reply.message.threadId, sent.message.threadId);
  assert.equal(reply.receipt.messageId, sent.message.messageId);
  assert.equal(reply.receipt.recipientParticipantId, "reviewer");
  assert.equal(reply.receipt.state, "acknowledged");
  assert.equal((await receipt()).state, "acknowledged");
  const [inspected] = await reviewer("acc_inbox", { messageId: sent.message.messageId });
  assert.equal(inspected.message.messageId, sent.message.messageId);
  assert.deepEqual(inspected.receipt, reply.receipt);
  assert.deepEqual(await reviewer("acc_inbox"), { items: [], nextCursor: null });
  const answer = await author("acc_inbox");
  assert.equal(answer.items[0].message.messageId, reply.message.messageId);
  assert.equal(answer.items[0].message.fromParticipantId, "reviewer");
  await author("acc_ack", { messageId: reply.message.messageId });
  assert.deepEqual(await author("acc_inbox"), { items: [], nextCursor: null });
});
