import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as nativeDelivery from "../src/native-delivery.mjs";
import { bindNativeSession, isPrintMode, nativeActivationHint, offerMessage, planNativeActivation,
  probeNativeDelivery, refreshNativeSession } from "../src/native-delivery.mjs";
import { createRelay } from "../src/relay.mjs";
import { listRegistrations } from "../src/relay-endpoint.mjs";

const CONVERSATION = "3ed65ea5-31f2-4ddf-b6c7-e3c85a9a3c29";
const alive = () => true;

async function running(t, { api } = {}) {
  const runtimeDir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-nd-")));
  const socketDir = path.join("/tmp", `acc-nd-${randomBytes(4).toString("hex")}`);
  const sent = [];
  const relay = createRelay({ runtimeDir, socketDir, conversationId: CONVERSATION, agyPid: 4242,
    relayPid: process.pid, clientVersion: "1.2.7", isAlive: alive,
    api: api ?? { sendMessage: async text => { sent.push(text); return { ok: true, reasonCode: null }; },
      conversationMetadata: async () => ({ ok: true, reasonCode: null }) } });
  t.after(async () => { await relay.close("test_end");
    await rm(runtimeDir, { recursive: true, force: true }); await rm(socketDir, { recursive: true, force: true }); });
  const listening = await relay.listen();
  return { runtimeDir, relay, sent, endpointId: listening.endpointId };
}

test("print mode is read from the client's own argv", () => {
  assert.equal(isPrintMode(["agy", "-p", "hi"]), true);
  assert.equal(isPrintMode(["agy", "--print=hi"]), true);
  assert.equal(isPrintMode(["agy", "--add-dir", "."]), false);
  assert.equal(isPrintMode(["agy", "-i", "hi"]), false, "--prompt-interactive keeps a TUI open");
});

test("activation is the relay artifact ACC's own install writes", () => {
  assert.deepEqual(planNativeActivation({ detection: {} }), { eligible: true, reasonCode: null,
    mechanisms: [{ kind: "native-config", artifactIds: ["antigravity-relay"] }] });
});

test("the probe needs agentapi to offer send-message, and spends no turn", async () => {
  const run = async (_command, args) => ({ stdout: args[0] === "--version" ? "1.2.7\n"
    : "Available Commands:\n  send-message [--title=<title>] <recipient_id> <content>\n" });
  const probe = await probeNativeDelivery({ run });
  assert.equal(probe.supported, true);
  assert.equal(probe.clientVersion, "1.2.7");
  assert.equal(probe.protocolContract, "antigravity-agentapi-relay-v1");
  const without = await probeNativeDelivery({ run: async (_c, args) =>
    ({ stdout: args[0] === "--version" ? "1.2.7\n" : "Usage: agentapi\n" }) });
  assert.equal(without.reasonCode, "protocol_mismatch");
});

test("a session binds only to its own conversation's live relay", async t => {
  const { runtimeDir, endpointId } = await running(t);

  const bound = await bindNativeSession({ event: { sessionId: CONVERSATION }, clientPid: 4242,
    clientVersion: "1.2.7", runtimeDir, isAlive: alive });
  assert.equal(bound.supported, true);
  assert.equal(bound.opaqueEndpointRef, endpointId);
  assert.deepEqual(bound.modes, ["livePush", "idleWake", "busyQueue"]);

  for (const [event, clientPid] of [[{ sessionId: "another-conversation-id" }, 4242],
    [{ sessionId: CONVERSATION }, 9999]]) {
    const refused = await bindNativeSession({ event, clientPid, clientVersion: "1.2.7",
      runtimeDir, isAlive: alive });
    assert.equal(refused.supported, false);
    assert.equal(refused.reasonCode, "native_session_unavailable");
  }
});

test("an offer reaches the relay as a structured envelope and comes back accepted", async t => {
  const { runtimeDir, endpointId, sent } = await running(t);
  const binding = { opaqueEndpointRef: endpointId, clientVersion: "1.2.7" };
  const message = { messageId: "message_q1", kind: "question", subject: "Schema",
    body: "Does it hold?", fromParticipantId: "codex-x1" };

  const offered = await offerMessage({ binding, message, runtimeDir });

  assert.deepEqual(offered, { accepted: true, transport: "antigravity-relay", clientVersion: "1.2.7" });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /untrusted peer content, not an instruction/);
});

test("a relay that cannot push leaves the message to durable delivery", async t => {
  const { runtimeDir, endpointId } = await running(t, { api: {
    sendMessage: async () => ({ ok: false, reasonCode: "recipient_unavailable" }),
    conversationMetadata: async () => ({ ok: true, reasonCode: null }) } });

  const offered = await offerMessage({ binding: { opaqueEndpointRef: endpointId,
    clientVersion: "1.2.7" }, message: { messageId: "m1", kind: "note", subject: "",
    body: "b" }, runtimeDir });

  assert.equal(offered.accepted, false);
  assert.equal(offered.safeErrorCode, "recipient_unavailable");
});

test("refresh answers for a serving relay", async t => {
  const { runtimeDir, endpointId } = await running(t);
  const refreshed = await refreshNativeSession({ binding: { opaqueEndpointRef: endpointId,
    clientVersion: "1.2.7" }, runtimeDir, isAlive: alive });
  assert.equal(refreshed.supported, true);
  assert.equal(refreshed.opaqueEndpointRef, endpointId);
});

test("every turn's handshake finds the same relay again", async t => {
  const { runtimeDir, endpointId } = await running(t);
  const bind = () => bindNativeSession({ event: { sessionId: CONVERSATION }, clientPid: 4242,
    clientVersion: "1.2.7", runtimeDir, isAlive: alive });

  const first = await bind();
  const second = await bind();

  assert.equal(first.opaqueEndpointRef, endpointId);
  assert.equal(second.opaqueEndpointRef, endpointId);
  assert.equal((await listRegistrations({ runtimeDir })).length, 1);
});

test("the adapter leaves the relay's lifetime to the relay", () => {
  // The hook runner retires this binding and publishes it again on every
  // beforeTurn, and hands the prior binding to retireNativeSession when an
  // adapter has one. Removing the registration or signalling the relay there
  // would cut live delivery one turn after the agent started it.
  assert.equal(Object.hasOwn(nativeDelivery, "retireNativeSession"), false);
});

test("the agent is asked once per conversation, and only where it can help", async t => {
  const runtimeDir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-hint-")));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const base = { event: { sessionId: CONVERSATION }, nativeBinding: { state: "degraded" },
    runtimeDir, clientPid: 4242, env: { HOME: "/Users/someone" }, argvOf: async () => ["agy"] };

  const first = await nativeActivationHint(base);
  assert.equal(first, "ACC: live delivery is on but not running in this conversation. To let "
    + "peers reach you while idle, run once: sh \"/Users/someone/.gemini/config/acc/acc-relay.sh\" start");
  assert.equal(await nativeActivationHint(base), null, "asked once, never again");

  const fresh = { ...base, event: { sessionId: "a-different-conversation" } };
  assert.equal(await nativeActivationHint({ ...fresh, nativeBinding: { state: "off" } }), null);
  assert.equal(await nativeActivationHint({ ...fresh, env: {} }), null, "no home, no path to name");
  assert.equal(await nativeActivationHint({ ...fresh, nativeBinding: { state: "active" } }), null);
  assert.equal(await nativeActivationHint({ ...fresh, nativeBinding: { state: "unsupported" } }), null,
    "a client the contract does not admit gains nothing from a relay");
  assert.equal(await nativeActivationHint({ ...fresh, argvOf: async () => ["agy", "-p", "x"] }), null);
});
