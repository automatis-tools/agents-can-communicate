import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAccChannel } from "../src/channel.mjs";
import { bindNativeSession, endpointDir, offerMessage, planNativeActivation,
  probeNativeDelivery, routeAck, routeReply } from "../src/native-delivery.mjs";

function runtime(t) {
  const root = mkdtempSync(path.join(tmpdir(), "acc-cc-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A channel bound to a given pid, listening under the runtime dir, with an
// injected reply sink so a real service is not needed.
async function channelFor(root, clientPid, { replies = [] } = {}) {
  const channel = createAccChannel({ endpointDir: endpointDir(root), clientPid,
    write: () => {}, routeReply: async input => { replies.push(input); },
    routeAck: async () => {} });
  await channel.listen();
  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return channel;
}

test("the probe admits a stable client at or above the minimum whose binary carries the protocol",
  async () => {
    const ok = await probeNativeDelivery({ realExecutable: "/vendor/claude",
      readVersion: async () => "2.1.258", hasChannel: async () => true });
    assert.deepEqual(ok, { supported: true, clientVersion: "2.1.258",
      protocolContract: "claude-code-channel-mcp-v1", executableFingerprint: null,
      modes: ["livePush", "idleWake", "busyQueue", "replyRoute"], reasonCode: null });
    const newer = await probeNativeDelivery({ realExecutable: "/vendor/claude",
      readVersion: async () => "2.4.0", hasChannel: async () => true });
    assert.equal(newer.supported, true);
    const older = await probeNativeDelivery({ realExecutable: "/vendor/claude",
      readVersion: async () => "2.1.257", hasChannel: async () => true });
    assert.equal(older.reasonCode, "below_minimum_version");
    const noProtocol = await probeNativeDelivery({ realExecutable: "/vendor/claude",
      readVersion: async () => "2.1.258", hasChannel: async () => false });
    assert.equal(noProtocol.reasonCode, "protocol_mismatch");
    const unreadable = await probeNativeDelivery({ realExecutable: "/vendor/claude",
      readVersion: async () => null, hasChannel: async () => true });
    assert.equal(unreadable.reasonCode, "feature_probe_failed");
  });

test("the activation plan adds only the captured channel flag and names the config artifact", () => {
  const plan = planNativeActivation({ detection: { realExecutable: "/vendor/bin/claude" },
    livePolicy: "actionable" });
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.mechanisms.map(m => m.kind), ["native-config", "shell-bootstrap"]);
  const shell = plan.mechanisms.find(m => m.kind === "shell-bootstrap");
  assert.equal(shell.command, "claude");
  assert.equal(shell.realExecutable, "/vendor/bin/claude");
  assert.deepEqual(shell.prefixArgs,
    ["--dangerously-load-development-channels", "plugin:agents-can-communicate@acc-local"]);
  assert.equal(plan.mechanisms.find(m => m.kind === "native-config").artifactIds[0], "claude-channel-mcp");
  assert.equal(planNativeActivation({ detection: {}, livePolicy: "all" }).eligible, false);
});

test("two Claude sessions cannot receive each other's endpoint", async t => {
  const root = runtime(t);
  const mine = await channelFor(root, 111);
  const theirs = await channelFor(root, 222);
  try {
    const bound = await bindNativeSession({ clientPid: 111, clientVersion: "2.1.258",
      runtimeDir: root });
    assert.equal(bound.supported, true);
    assert.equal(bound.opaqueEndpointRef, mine.endpointId,
      "the binding must be the caller's own endpoint, never the first registration");
    assert.notEqual(bound.opaqueEndpointRef, theirs.endpointId);
    assert.deepEqual(bound.modes, ["livePush", "idleWake", "busyQueue", "replyRoute"]);
    const unknown = await bindNativeSession({ clientPid: 999, clientVersion: "2.1.258",
      runtimeDir: root });
    assert.deepEqual([unknown.supported, unknown.reasonCode], [false, "handshake_failed"]);
  } finally {
    mine.close(); theirs.close();
  }
});

test("an offer resolves the exact endpoint and delivers one envelope", async t => {
  const root = runtime(t);
  const channel = await channelFor(root, 333);
  try {
    const binding = { opaqueEndpointRef: channel.endpointId, clientVersion: "2.1.258" };
    const message = { messageId: "message_x", kind: "question", subject: "s", body: "hello" };
    const result = await offerMessage({ binding, message, runtimeDir: root });
    assert.deepEqual(result, { accepted: true, transport: "claude-channel", clientVersion: "2.1.258" });
    // A dedup: the same id is accepted-but-duplicate, so still accepted.
    const again = await offerMessage({ binding, message, runtimeDir: root });
    assert.equal(again.accepted, true);
    // An unknown endpoint id stays recipient_unavailable.
    const missing = await offerMessage({ binding: { opaqueEndpointRef: "endpoint_absent",
      clientVersion: "2.1.258" }, message, runtimeDir: root });
    assert.deepEqual(missing, { accepted: false, transport: "claude-channel",
      clientVersion: "2.1.258", safeErrorCode: "recipient_unavailable" });
    // A traversal endpoint id cannot escape the endpoint directory.
    const escape = await offerMessage({ binding: { opaqueEndpointRef: "../../etc/passwd",
      clientVersion: "2.1.258" }, message, runtimeDir: root });
    assert.equal(escape.safeErrorCode, "recipient_unavailable");
  } finally {
    channel.close();
  }
});

test("reply and ack route to the real conversation service by exact session", async () => {
  const calls = [];
  const service = {
    replyToMessage: async input => { calls.push(["reply", input]); return { reply: {} }; },
    acknowledgeMessage: async input => { calls.push(["ack", input]); return {}; },
  };
  const session = { sessionId: "session_a", generation: "generation_a" };
  await routeReply({ service, session, messageId: "message_a", body: "answer" });
  await routeAck({ service, session, messageId: "message_a" });
  assert.deepEqual(calls, [
    ["reply", { sessionId: "session_a", generation: "generation_a", messageId: "message_a",
      body: "answer", clientMessageId: "channel-reply-message_a" }],
    ["ack", { sessionId: "session_a", generation: "generation_a", messageId: "message_a" }],
  ]);
});
