import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createIndicatorFixture as fixture } from "../../../tests/helpers/indicator-fixture.mjs";
import { storeSessionBinding } from "@agents-can-communicate/adapter-sdk";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";


async function snapshot(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.filter(e => e.isFile()).map(async e => {
    const file = path.join(e.parentPath ?? e.path, e.name);
    return [path.relative(root, file), (await readFile(file)).toString("base64")];
  })));
}

test("an idle open session keeps automatic reception after its lease expires, without writes", async t => {
  const f = await fixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  await f.attempt("active");
  f.clock.advance(4 * 60_000);
  const before = await snapshot(f.dataHome);
  const result = await f.read();
  assert.equal(result.label, "ACC ●");
  assert.equal(result.health, "ready");
  assert.equal(result.reception, "automatic");
  assert.equal(result.leaseCurrent, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-endpoint|generation_|native-session/);
  assert.deepEqual(await snapshot(f.dataHome), before);
});

test("unsupported automatic reception is a normal turn or inbox mode", async t => {
  for (const [adapterId, version, want] of [["gemini_cli", "0.57.0", "turn"], ["grok", "1.0.24", "inbox"]]) {
    const f = await fixture(t, { adapterId, version });
    await f.attempt("unsupported", "native_delivery_unsupported");
    const result = await f.read();
    assert.equal(result.label, `ACC ● · ${want}`);
    assert.equal(result.health, "ready");
    assert.equal(result.reception, want);
    assert.equal(result.action, null);
  }
});

test("a client older than captured next-turn support is not promised turn delivery", async t => {
  const f = await fixture(t, { adapterId: "gemini_cli", version: "0.1.0" });
  assert.equal((await f.read()).reception, "inbox");
});

test("a known failure keeps the fallback visible and explains a concrete next action", async t => {
  const f = await fixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  await f.attempt("degraded", "handshake_failed");
  let result = await f.read();
  assert.equal(result.label, "ACC ! · turn");
  assert.equal(result.health, "problem");
  assert.equal(result.reasonCode, "handshake_failed");
  assert.match(result.action, /acc doctor/);
  assert.match(result.detail, /next.*turn|next.*prompt/i);
  await f.attempt("active");
  result = await f.read();
  assert.equal(result.label, "ACC ●", "a successful handshake clears the old failure");
});

test("a replaced or closed generation cannot inherit a previous ready indicator", async t => {
  const f = await fixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  await f.attempt("active");
  await storeSessionBinding({ ...f.owner, generation: "generation_replaced" });
  assert.equal((await f.read()).health, "problem");
  await storeSessionBinding(f.owner);
  await f.service.closeSession({ sessionId: f.session.sessionId, generation: f.session.generation });
  assert.equal((await f.read()).health, "problem");
});

test("missing registration does not invent a background connection attempt", async t => {
  const f = await fixture(t);
  await rm(path.join(f.dataHome, "acc", "native-workspaces"), { recursive: true });
  const result = await f.read();
  assert.equal(result.label, "ACC !");
  assert.equal(result.reasonCode, "not_registered");
  assert.match(result.action, /prompt|install/i);
});

test("corrupt local data produces actionable failure without leaking its contents", async t => {
  const f = await fixture(t);
  const dir = path.join(f.runtimeDir, "bindings");
  const [name] = await readdir(dir);
  await writeFile(path.join(dir, name), "secret-corrupt-content");
  const result = await f.read();
  assert.equal(result.health, "problem");
  assert.equal(result.reasonCode, "state_unreadable");
  assert.match(result.action, /acc doctor/);
  assert.doesNotMatch(JSON.stringify(result), /secret-corrupt-content/);
});

test("an actual recorded offer failure changes the badge until a later successful offer", async t => {
  const f = await fixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  await f.attempt("active");
  const sender = await f.service.openSession({ workspaceId: f.workspaceId,
    participantId: "sender", harness: "fixture", heartbeatCadenceMs: 30_000 });
  let accepted = false;
  const adapter = { ...createClaudeCodeAdapter(), offerMessage: async () => ({ accepted,
    safeErrorCode: "transport_permission_denied", transport: "claude-inbox", clientVersion: "2.1.295" }) };
  const router = createDeliveryRouter({ service: f.service, adapters: [adapter], clock: f.clock,
    readLivePolicy: async () => "actionable" });
  const send = async key => {
    f.clock.advance(1000);
    const message = await f.service.sendMessage({ sessionId: sender.sessionId, generation: sender.generation,
      clientMessageId: key, toParticipantIds: ["tester"], kind: "question", obligation: "reply",
      subject: "test", body: "test", artifacts: [], inReplyTo: null });
    return router.offer(message);
  };
  assert.equal((await send("denied"))[0].errorCode, "transport_permission_denied");
  assert.equal((await f.read()).label, "ACC ! · turn");
  accepted = true;
  assert.equal((await send("accepted"))[0].outcome, "woken");
  assert.equal((await f.read()).label, "ACC ●");
});

test("the public indicator command works when all filesystem writes and child processes are forbidden", async t => {
  const f = await fixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  const binary = path.resolve(import.meta.dirname, "../../../bin/acc-indicator.mjs");
  const before = await snapshot(f.dataHome);
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--permission", "--allow-fs-read=*", binary, "--adapter", "claude_code",
      "--native-session", "native-session", "--json"],
    { env: { ...process.env, ACC_DATA_HOME: f.dataHome }, timeout: 3000 });
  assert.equal(JSON.parse(stdout).label, "ACC ●");
  assert.deepEqual(await snapshot(f.dataHome), before);
});

test("a failed verification of an expired endpoint becomes a known failure", async t => {
  const f = await fixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  await f.attempt("active");
  f.clock.advance(4 * 60_000);
  assert.equal((await f.read()).label, "ACC ●", "expiry alone is not failure");
  const sender = await f.service.openSession({ workspaceId: f.workspaceId,
    participantId: "sender", harness: "fixture", heartbeatCadenceMs: 30_000 });
  const router = createDeliveryRouter({ service: f.service, clock: f.clock,
    adapters: [{ ...createClaudeCodeAdapter(), refreshNativeSession: async () => { throw new Error("dead endpoint"); } }],
    readLivePolicy: async () => "actionable" });
  const message = await f.service.sendMessage({ sessionId: sender.sessionId, generation: sender.generation,
    clientMessageId: "refresh-failure", toParticipantIds: ["tester"], kind: "question", obligation: "reply",
    subject: "test", body: "test", artifacts: [], inReplyTo: null });
  assert.equal((await router.offer(message))[0].errorCode, "recipient_unavailable");
  assert.equal((await f.read()).label, "ACC ! · turn");
});
