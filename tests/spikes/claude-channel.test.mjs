import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { channelScript, connectSocket, nextSocketMessage, runCaptureClient,
  runRejectedChannel, sendEnvelope, startChannel, trustedTempDir }
  from "../helpers/claude-channel.mjs";

// Kept cohesive above 300 lines because every case drives one disposable
// Channel child through the same stdio + Unix-socket composition; splitting
// would duplicate the capture harness the real-client capture also runs.

const PROTOCOL_CONTRACT = "claude-code-channel-mcp-v1";
const SECRET_BODY = "SECRET-BODY-7f3a must never be logged";
const SECRET_SUBJECT = "SECRET-SUBJECT-2b9e";
const SECRET_REPLY = "SECRET-REPLY-9c1d must never be logged";

const withChannel = fn => async () => {
  const channel = await startChannel();
  try {
    await fn(channel);
  } finally {
    const exited = await channel.close();
    assert.equal(exited.code, 0, exited.stderr);
    channel.remove();
  }
};

const envelope = (channel, overrides = {}) => ({
  nonce: channel.nonce ?? channel.registration.nonce,
  messageId: "message_capture",
  kind: "question",
  subject: SECRET_SUBJECT,
  body: SECRET_BODY,
  ...overrides,
});

const events = (channel, name) => channel.observations().filter(item => item.event === name);

test("the channel advertises the captured contract and explicit tools only",
  withChannel(async channel => {
    const initialized = await channel.request("initialize", { protocolVersion: "2025-11-25" });
    assert.deepEqual(initialized.capabilities, {
      experimental: { "claude/channel": {} },
      tools: {},
    });
    assert.equal(Object.hasOwn(initialized.capabilities.experimental, "claude/channel/permission"),
      false);
    assert.match(initialized.instructions, /untrusted/);
    assert.match(initialized.instructions, /acc_reply/);
    const { tools } = await channel.request("tools/list", {});
    assert.deepEqual(tools.map(tool => tool.name), ["acc_reply", "acc_ack"]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(tool.inputSchema.required.slice(0, 1), ["messageId"]);
    }
    assert.deepEqual(tools[0].inputSchema.required, ["messageId", "body"]);
  }));

test("the endpoint is private, session-scoped, and registered for the parent client",
  withChannel(async channel => {
    assert.equal(statSync(channel.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(channel.registrationPath).mode & 0o777, 0o600);
    const { registration } = channel;
    assert.equal(registration.schemaVersion, 1);
    assert.equal(registration.protocolContract, PROTOCOL_CONTRACT);
    assert.equal(registration.socketPath, channel.socketPath);
    assert.match(registration.nonce, /^[0-9a-f]{64}$/);
    assert.equal(registration.clientPid, process.pid);
    assert.equal(registration.channelPid, channel.child.pid);
    assert.equal(path.dirname(registration.socketPath), channel.captureDir);
    assert.equal(events(channel, "endpoint_listening").length, 1);
  }));

test("a capture client's envelope becomes exactly one Channel notification",
  withChannel(async channel => {
    await channel.initialize();
    const run = await runCaptureClient({ socketPath: channel.socketPath,
      nonce: channel.registration.nonce, messageId: "message_capture",
      subject: SECRET_SUBJECT, body: SECRET_BODY });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.result, { accepted: true, duplicate: false, messageId: "message_capture" });

    const offered = await channel.nextMessage();
    assert.equal(offered.method, "notifications/claude/channel");
    assert.deepEqual(offered.params.meta, { message_id: "message_capture", kind: "question" });
    assert.equal(typeof offered.params.content, "string");
    assert.match(offered.params.content, /message_capture/);
    assert.match(offered.params.content, /untrusted/);
    assert.equal(offered.params.content.includes(SECRET_BODY), true);
    assert.equal(offered.params.content.includes(SECRET_SUBJECT), true);
    assert.equal(events(channel, "notification_accepted").length, 1);
    assert.deepEqual(events(channel, "notification_accepted")[0].messageId, "message_capture");
  }));

test("a repeated message id is reported as a duplicate and never notified twice",
  withChannel(async channel => {
    await channel.initialize();
    const first = await runCaptureClient({ socketPath: channel.socketPath,
      nonce: channel.registration.nonce, messageId: "message_capture" });
    const second = await runCaptureClient({ socketPath: channel.socketPath,
      nonce: channel.registration.nonce, messageId: "message_capture" });
    assert.deepEqual(first.result, { accepted: true, duplicate: false, messageId: "message_capture" });
    assert.deepEqual(second.result, { accepted: true, duplicate: true, messageId: "message_capture" });
    assert.equal(second.code, 0, second.stderr);

    assert.equal((await channel.nextMessage()).method, "notifications/claude/channel");
    assert.equal(await channel.nextMessageOrNull(150), null);
    assert.equal(events(channel, "notification_accepted").length, 1);
    assert.equal(events(channel, "duplicate_suppressed").length, 1);
  }));

test("an envelope queued before the client initialized is offered exactly once afterwards",
  withChannel(async channel => {
    const run = await runCaptureClient({ socketPath: channel.socketPath,
      nonce: channel.registration.nonce, messageId: "message_early" });
    assert.deepEqual(run.result, { accepted: true, duplicate: false, messageId: "message_early" });
    assert.equal(events(channel, "notification_accepted").length, 0);
    await channel.initialize();
    const offered = await channel.nextMessage();
    assert.equal(offered.method, "notifications/claude/channel");
    assert.equal(await channel.nextMessageOrNull(100), null);
    assert.equal(events(channel, "notification_accepted").length, 1);
  }));

test("the channel rejects envelopes outside the closed shape without notifying",
  withChannel(async channel => {
    await channel.initialize();
    const cases = [
      [{ ...envelope(channel), transcript: "x" }, "unknown_field"],
      [{ ...envelope(channel), nonce: "f".repeat(64) }, "bad_nonce"],
      [{ ...envelope(channel), messageId: "" }, "bad_message_id"],
      [{ ...envelope(channel), kind: "prompt" }, "bad_kind"],
      [{ ...envelope(channel), body: "" }, "bad_body"],
      [{ ...envelope(channel), inReplyTo: 7 }, "bad_in_reply_to"],
      [{ ...envelope(channel), body: "x".repeat(64 * 1024) }, "envelope_too_large"],
      [[envelope(channel)], "not_an_object"],
    ];
    for (const [payload, reasonCode] of cases) {
      const socket = await connectSocket(channel.socketPath);
      sendEnvelope(socket, payload);
      const response = await nextSocketMessage(socket);
      assert.equal(response.reasonCode, reasonCode, JSON.stringify(response));
      assert.equal(response.accepted, false);
      socket.end();
    }
    const socket = await connectSocket(channel.socketPath);
    socket.write("not json\n");
    assert.equal((await nextSocketMessage(socket)).reasonCode, "invalid_json");
    socket.end();
    assert.equal(await channel.nextMessageOrNull(100), null);
    const rejected = events(channel, "envelope_rejected");
    assert.deepEqual(rejected.map(item => item.reasonCode), [...cases.map(([, code]) => code),
      "invalid_json"]);
    assert.equal(events(channel, "notification_accepted").length, 0);
  }));

test("acc_reply and acc_ack route to the originating connection and are observed",
  withChannel(async channel => {
    await channel.initialize();
    const socket = await connectSocket(channel.socketPath);
    sendEnvelope(socket, envelope(channel));
    assert.deepEqual(await nextSocketMessage(socket),
      { accepted: true, duplicate: false, messageId: "message_capture" });
    assert.equal((await channel.nextMessage()).method, "notifications/claude/channel");

    const replied = await channel.request("tools/call", { name: "acc_reply",
      arguments: { messageId: "message_capture", body: SECRET_REPLY } });
    assert.deepEqual(replied, { content: [{ type: "text", text: "sent" }] });
    assert.deepEqual(await nextSocketMessage(socket),
      { messageId: "message_capture", type: "reply", body: SECRET_REPLY });
    const acked = await channel.request("tools/call", { name: "acc_ack",
      arguments: { messageId: "message_capture" } });
    assert.deepEqual(acked, { content: [{ type: "text", text: "sent" }] });
    assert.deepEqual(await nextSocketMessage(socket), { messageId: "message_capture", type: "ack" });
    socket.end();

    await assert.rejects(channel.request("tools/call", { name: "acc_reply",
      arguments: { messageId: "message_unknown", body: "x" } }), /no delivered message/);
    await assert.rejects(channel.request("tools/call", { name: "acc_reply",
      arguments: { messageId: "message_capture", body: "x", extra: true } }), /unknown argument/);
    assert.deepEqual(events(channel, "reply_routed"),
      [{ ...events(channel, "reply_routed")[0], messageId: "message_capture", delivered: true }]);
    assert.equal(events(channel, "ack_routed").length, 1);
  }));

test("a reply after the originating client disconnected is still observed",
  withChannel(async channel => {
    await channel.initialize();
    await runCaptureClient({ socketPath: channel.socketPath,
      nonce: channel.registration.nonce, messageId: "message_gone" });
    assert.equal((await channel.nextMessage()).method, "notifications/claude/channel");
    await new Promise(resolve => setTimeout(resolve, 20));
    const replied = await channel.request("tools/call", { name: "acc_reply",
      arguments: { messageId: "message_gone", body: SECRET_REPLY } });
    assert.deepEqual(replied, { content: [{ type: "text", text: "recorded" }] });
    assert.deepEqual(events(channel, "reply_routed").map(item => item.delivered), [false]);
  }));

test("observations carry event names, ids, and timestamps but never content",
  withChannel(async channel => {
    await channel.initialize();
    const socket = await connectSocket(channel.socketPath);
    sendEnvelope(socket, envelope(channel));
    await nextSocketMessage(socket);
    await channel.nextMessage();
    await channel.request("tools/call", { name: "acc_reply",
      arguments: { messageId: "message_capture", body: SECRET_REPLY } });
    await nextSocketMessage(socket);
    sendEnvelope(await connectSocket(channel.socketPath),
      { ...envelope(channel), messageId: "message_two", unknown: SECRET_BODY });
    await new Promise(resolve => setTimeout(resolve, 30));
    socket.end();

    const raw = readFileSync(channel.observationPath, "utf8");
    for (const secret of [SECRET_BODY, SECRET_SUBJECT, SECRET_REPLY, channel.registration.nonce]) {
      assert.equal(raw.includes(secret), false, `observations leak ${secret}`);
    }
    assert.equal(statSync(channel.observationPath).mode & 0o777, 0o600);
    const allowed = new Set(["event", "at", "messageId", "kind", "reasonCode", "delivered"]);
    for (const record of channel.observations()) {
      assert.equal(typeof record.event, "string");
      assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      for (const key of Object.keys(record)) assert.equal(allowed.has(key), true, key);
    }
    assert.deepEqual(channel.observations().map(item => item.event), ["endpoint_listening",
      "notification_accepted", "reply_routed", "envelope_rejected"]);
  }));

test("the channel refuses a capture directory it cannot trust", async () => {
  const inRepo = mkdtempSync(path.join(path.dirname(channelScript), "acc-capture-"));
  const loose = mkdtempSync(path.join(os.tmpdir(), "acc-channel-loose-"));
  chmodSync(loose, 0o755);
  try {
    for (const [dir, pattern] of [
      [inRepo, /must be outside the repository/],
      [loose, /private user-owned directory/],
      ["relative/dir", /is absolute/],
      [path.join(os.tmpdir(), "acc-channel-missing-dir"), /must exist/],
    ]) {
      const result = await runRejectedChannel({ ACC_CHANNEL_CAPTURE_DIR: dir });
      assert.equal(result.code, 2, dir);
      assert.match(result.stderr, pattern);
    }
    assert.equal(existsSync(path.join(inRepo, "endpoint.sock")), false);
  } finally {
    rmSync(inRepo, { recursive: true, force: true });
    rmSync(loose, { recursive: true, force: true });
  }
});

test("the socket is removed on stdin end and on SIGTERM", async () => {
  for (const kill of [false, true]) {
    const channel = await startChannel();
    const exited = await (kill ? channel.kill() : channel.close());
    assert.equal(exited.code, 0, exited.stderr);
    assert.equal(existsSync(channel.socketPath), false);
    assert.deepEqual(channel.observations().at(-1).event, "endpoint_closed");
    channel.remove();
  }
});

test("the capture client refuses arguments outside its closed usage", async () => {
  const dir = trustedTempDir();
  try {
    const missingSocket = path.join(dir, "missing.sock");
    const base = { socketPath: missingSocket, nonce: "a".repeat(64), messageId: "message_1" };
    const usage = await runCaptureClient({ ...base, extraArgs: ["--unknown", "x"] });
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /usage:/);
    const badKind = await runCaptureClient({ ...base, kind: "prompt" });
    assert.equal(badKind.code, 2);
    const unreachable = await runCaptureClient(base);
    assert.equal(unreachable.code, 3);
    assert.equal(unreachable.result.accepted, false);
    assert.equal(unreachable.result.reasonCode, "transport_unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
