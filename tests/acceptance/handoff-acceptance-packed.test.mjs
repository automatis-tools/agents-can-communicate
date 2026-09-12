import assert from "node:assert/strict";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { connectMcp, PROTOCOL_META } from "../helpers/mcp-client.mjs";
import { PROTOCOL_VERSION } from "../../packages/mcp-server/src/server.mjs";

const owner = session => ["--session", session.sessionId, "--generation", session.generation];

test("installed ack refuses to hide a reply-required request or question", async t => {
  const packed = await createPackedAcc(t);
  const sender = await packed.acc(["attach", "--participant", "sender"]);
  const reader = await packed.acc(["attach", "--participant", "reader"]);
  for (const kind of ["request", "question"]) {
    const args = kind === "request" ? ["request", "--title", "Check locally", "--detail", "Report back"]
      : ["message", "--type", "question", "--subject", "Check locally", "--body", "Report back"];
    const { message } = await packed.acc([...args, ...owner(sender), "--to", "reader"]);
    const before = await packed.acc(["sync", "--scope", "full"]);

    const error = await packed.accError(["ack", ...owner(reader), "--message", message.messageId]);

    assert.equal(error?.code, 5, `bare ack silently resolved a ${kind}`);
    assert.match(error.stdout, /reply/);
    assert.deepEqual(await packed.acc(["sync", "--scope", "full"]), before);
    const pending = await packed.acc(["inbox", ...owner(reader)]);
    assert.ok(pending.items.some(item => item.message.messageId === message.messageId));
    const status = await packed.acc(["status", ...owner(reader)]);
    assert.ok(status.attention.some(item => item.sourceId === message.messageId
      && item.kind === "reply_required"));
    await packed.acc(["reply", ...owner(reader), "--message", message.messageId,
      "--body", "Declined: outside my scope."]);
    assert.deepEqual((await packed.acc(["inbox", ...owner(reader)])).items, []);
  }
});

test("installed handoff ack allows scoped acceptance and a later reply without a new receipt", async t => {
  const packed = await createPackedAcc(t);
  const reader = await packed.acc(["attach", "--participant", "reader"]);
  for (const status of ["complete", "partial", "blocked"]) {
    const sender = await packed.acc(["attach", "--participant", `sender-${status}`]);
    const sent = await packed.acc(["finish", ...owner(sender), "--to", "reader",
      "--goal", "Check the local gate", "--status", status, "--completed", "Context preserved"]);
    assert.equal(sent.message.obligation, "acknowledge");
    const input = [...owner(reader), "--message", sent.message.messageId];
    const receipt = await packed.acc(["ack", ...input]);
    const acceptance = await packed.acc(["reply", ...input,
      "--body", "I take only the local gate check."]);
    assert.deepEqual(acceptance.receipt, receipt);
    const resultArgs = ["reply", ...input, "--body", "Checked: gate passes.",
      "--client-message-id", `result-${status}`];
    const result = await packed.acc(resultArgs);
    assert.notEqual(result.message.messageId, acceptance.message.messageId);
    assert.equal(result.message.threadId, sent.message.threadId);
    assert.equal(result.message.inReplyTo, sent.message.messageId);
    assert.deepEqual(result.receipt, receipt);
    const beforeRetry = await packed.acc(["sync", "--scope", "full"]);
    const retry = await packed.acc(resultArgs);
    assert.deepEqual(retry.message, result.message);
    assert.deepEqual(await packed.acc(["sync", "--scope", "full"]), beforeRetry);
    const conflict = await packed.accError([...resultArgs.slice(0, -4),
      "--body", "Different", "--client-message-id", `result-${status}`]);
    assert.equal(conflict?.code, 5);
    assert.deepEqual(await packed.acc(["sync", "--scope", "full"]), beforeRetry);
    const [inspected] = await packed.acc(["inbox", ...input]);
    assert.deepEqual(inspected.receipt, receipt);
    assert.deepEqual((await packed.acc(["inbox", ...owner(reader)])).items, []);
  }
});

test("installed MCP preserves unanswered obligations and permits a reply after handoff ack", async t => {
  const packed = await createPackedAcc(t);
  const sender = await packed.acc(["attach", "--participant", "sender"]);
  const client = connectMcp({ cwd: packed.project, dataHome: packed.dataHome,
    binary: packed.mcpBin, participant: "reader", env: packed.env });
  t.after(() => client.close());
  const call = (name, args = {}) => client.request("tools/call",
    { name, arguments: args, _meta: PROTOCOL_META(PROTOCOL_VERSION) });
  const value = response => {
    assert.equal(response.error, undefined);
    assert.notEqual(response.result.isError, true, response.result.content[0].text);
    return response.result.structuredContent;
  };
  value(await call("acc_status"));
  const { message } = await packed.acc(["request", ...owner(sender), "--to", "reader",
    "--title", "Check locally", "--detail", "Report back"]);
  const refused = await call("acc_ack", { messageId: message.messageId });
  assert.equal(refused.result.isError, true, "MCP ack silently resolved the request");
  assert.match(refused.result.content[0].text, /reply/);
  const pending = value(await call("acc_inbox"));
  assert.equal(pending.items[0].receipt.state, "queued");
  assert.equal(pending.items[0].message.messageId, message.messageId);
  value(await call("acc_reply", { messageId: message.messageId,
    body: "Declined: outside my scope." }));
  const handoff = await packed.acc(["finish", ...owner(sender), "--to", "reader",
    "--goal", "Preserve context", "--status", "complete"]);
  const messageId = handoff.message.messageId;
  const receipt = value(await call("acc_ack", { messageId }));
  const args = { messageId, body: "Received; no new work accepted.", clientMessageId: "mcp_reply" };
  const reply = value(await call("acc_reply", args));
  assert.deepEqual(reply.receipt, receipt);
  assert.equal(reply.message.inReplyTo, messageId);
  assert.deepEqual(value(await call("acc_reply", args)).message, reply.message);
});
