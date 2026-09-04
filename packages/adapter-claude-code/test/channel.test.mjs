import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAccChannel } from "../src/channel.mjs";

const SECRET_BODY = "SECRET-BODY-4a2f must never be logged";
const SECRET_SUBJECT = "SECRET-SUBJECT-91cd";
const SECRET_REPLY = "SECRET-REPLY-77be must never be logged";

function harness(t, { routeReply, routeAck } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-cc-channel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outbound = [];
  const observations = [];
  const replies = [];
  const acks = [];
  const channel = createAccChannel({ endpointDir: dir, clientPid: 4242,
    write: payload => outbound.push(payload),
    observe: record => observations.push(record),
    routeReply: async input => { replies.push(input); return (routeReply ?? (() => {}))(input); },
    routeAck: async input => { acks.push(input); return (routeAck ?? (() => {}))(input); } });
  return { dir, channel, outbound, observations, replies, acks };
}

async function initialize(channel, outbound) {
  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25" } }));
  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return outbound.find(item => item.id === 1).result;
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
function envelope(nonce, overrides = {}) {
  return { nonce, messageId: "message_a", kind: "question", subject: SECRET_SUBJECT,
    body: SECRET_BODY, ...overrides };
}
function nextLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) { socket.off("data", onData); resolve(JSON.parse(buffer.slice(0, newline))); }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    setTimeout(() => reject(new Error("timeout")), 500);
  });
}

test("the channel advertises the captured contract and explicit tools only", async t => {
  const { channel, outbound } = harness(t);
  await channel.listen();
  try {
    const result = await initialize(channel, outbound);
    assert.deepEqual(result.capabilities, { experimental: { "claude/channel": {} }, tools: {} });
    assert.equal(Object.hasOwn(result.capabilities.experimental, "claude/channel/permission"), false);
    assert.match(result.instructions, /untrusted/);
    assert.match(result.instructions, /acc_reply/);
    await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const tools = outbound.find(item => item.id === 2).result.tools;
    assert.deepEqual(tools.map(tool => tool.name), ["acc_reply", "acc_ack"]);
    for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  } finally {
    channel.close();
  }
});

test("the registration is private, names the client pid, and is challenged by nonce", async t => {
  const { channel } = harness(t);
  await channel.listen();
  try {
    assert.equal(statSync(channel.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(channel.registrationPath).mode & 0o777, 0o600);
    const record = JSON.parse(readFileSync(channel.registrationPath, "utf8"));
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.clientPid, 4242);
    assert.equal(record.protocolContract, "claude-code-channel-mcp-v1");
    assert.match(record.nonce, /^[0-9a-f]{64}$/);
    assert.deepEqual(record.modes, ["livePush", "idleWake", "busyQueue", "replyRoute"]);
    assert.equal(record.endpointId, channel.endpointId);
  } finally {
    channel.close();
  }
});

test("one envelope becomes one notification; a duplicate id is never notified twice", async t => {
  const { channel, outbound, observations } = harness(t);
  await channel.listen();
  try {
    await initialize(channel, outbound);
    const nonce = JSON.parse(readFileSync(channel.registrationPath, "utf8")).nonce;
    const socket = await connect(channel.socketPath);
    socket.write(`${JSON.stringify(envelope(nonce))}\n`);
    assert.deepEqual(await nextLine(socket), { accepted: true, duplicate: false, messageId: "message_a" });
    const offered = outbound.find(item => item.method === "notifications/claude/channel");
    assert.deepEqual(offered.params.meta, { message_id: "message_a", kind: "question" });
    assert.equal(offered.params.content.includes(SECRET_BODY), true);
    assert.match(offered.params.content, /untrusted/);

    const second = await connect(channel.socketPath);
    second.write(`${JSON.stringify(envelope(nonce, { body: "again" }))}\n`);
    assert.deepEqual(await nextLine(second), { accepted: true, duplicate: true, messageId: "message_a" });
    assert.equal(outbound.filter(item => item.method === "notifications/claude/channel").length, 1);
    assert.equal(observations.filter(item => item.event === "notification_accepted").length, 1);
    assert.equal(observations.filter(item => item.event === "duplicate_suppressed").length, 1);
    socket.end(); second.end();
  } finally {
    channel.close();
  }
});

test("the channel rejects envelopes outside the closed shape and a bad nonce", async t => {
  const { channel, outbound, observations } = harness(t);
  await channel.listen();
  try {
    await initialize(channel, outbound);
    const nonce = JSON.parse(readFileSync(channel.registrationPath, "utf8")).nonce;
    for (const [patch, reasonCode] of [
      [{ nonce: "f".repeat(64) }, "bad_nonce"], [{ transcript: "x" }, "unknown_field"],
      [{ kind: "prompt" }, "bad_kind"], [{ body: "" }, "bad_body"]]) {
      const socket = await connect(channel.socketPath);
      socket.write(`${JSON.stringify(envelope(nonce, patch))}\n`);
      assert.equal((await nextLine(socket)).reasonCode, reasonCode);
      socket.end();
    }
    assert.equal(outbound.some(item => item.method === "notifications/claude/channel"), false);
    assert.equal(observations.filter(item => item.event === "envelope_rejected").length, 4);
  } finally {
    channel.close();
  }
});

test("acc_reply and acc_ack route through the injected service and are observed", async t => {
  const { channel, outbound, observations, replies, acks } = harness(t);
  await channel.listen();
  try {
    await initialize(channel, outbound);
    const nonce = JSON.parse(readFileSync(channel.registrationPath, "utf8")).nonce;
    const socket = await connect(channel.socketPath);
    socket.write(`${JSON.stringify(envelope(nonce))}\n`);
    await nextLine(socket);
    await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "acc_reply", arguments: { messageId: "message_a", body: SECRET_REPLY } } }));
    assert.deepEqual(outbound.find(item => item.id === 5).result, { content: [{ type: "text", text: "sent" }] });
    assert.deepEqual(replies, [{ messageId: "message_a", body: SECRET_REPLY }]);
    await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "acc_ack", arguments: { messageId: "message_a" } } }));
    assert.deepEqual(acks, [{ messageId: "message_a" }]);
    await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "acc_reply", arguments: { messageId: "message_unknown", body: "x" } } }));
    assert.match(outbound.find(item => item.id === 7).error.message, /no delivered message/);
    assert.deepEqual(observations.filter(item => item.event === "reply_routed").map(i => i.messageId),
      ["message_a"]);
    socket.end();
  } finally {
    channel.close();
  }
});

test("observations and outbound never carry the body, reply, socket path, or nonce", async t => {
  const { channel, outbound, observations } = harness(t, { routeReply: () => {} });
  await channel.listen();
  try {
    await initialize(channel, outbound);
    const nonce = JSON.parse(readFileSync(channel.registrationPath, "utf8")).nonce;
    const socket = await connect(channel.socketPath);
    socket.write(`${JSON.stringify(envelope(nonce))}\n`);
    await nextLine(socket);
    await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "acc_reply", arguments: { messageId: "message_a", body: SECRET_REPLY } } }));
    const raw = JSON.stringify(observations);
    for (const secret of [SECRET_BODY, SECRET_SUBJECT, SECRET_REPLY, nonce, channel.socketPath]) {
      assert.equal(raw.includes(secret), false, `observations leak ${secret}`);
    }
    const allowed = new Set(["event", "at", "messageId", "kind", "reasonCode"]);
    for (const record of observations) {
      for (const key of Object.keys(record)) assert.equal(allowed.has(key), true, key);
    }
    socket.end();
  } finally {
    channel.close();
  }
});
