import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createAntigravityAdapter } from "@agents-can-communicate/adapter-antigravity";
import { createRelay } from "@agents-can-communicate/adapter-antigravity/relay";
import { listRegistrations } from "@agents-can-communicate/adapter-antigravity/relay-endpoint";
import { loadNativeAttempt, storeSessionBinding } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { establishNativeBinding } from "@agents-can-communicate/hook-runner/native-binding";
import { recordInstall } from "@agents-can-communicate/installer";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

import { activateAntigravityRelay } from "../../bin/entrypoints/antigravity-relay-binding.mjs";
import { createFakeIds } from "../helpers/memory-store.mjs";

const CONVERSATION = "3ed65ea5-31f2-4ddf-b6c7-e3c85a9a3c29";

async function fixture(t, { installedPolicy = "actionable" } = {}) {
  const root = await realpath(await mkdtemp("/tmp/acc-agr-"));
  const runtimeDir = path.join(root, "workspace");
  const dataHome = path.join(root, "data");
  const clock = { now: () => new Date().toISOString() };
  const ids = createFakeIds();
  const store = await openFilesystemStore({ root: runtimeDir, clock, ids, workspaceId: "workspace_relay" });
  const service = createCoordinationService({ store, clock, ids });
  const opened = await service.openSession({ workspaceId: "workspace_relay",
    participantId: "antigravity", harness: "antigravity", heartbeatCadenceMs: 30_000 });
  const session = { sessionId: opened.sessionId, generation: opened.generation,
    clientPid: process.pid, harnessSessionId: CONVERSATION };
  const binding = { runtimeDir, harnessSessionId: CONVERSATION, accSessionId: opened.sessionId,
    generation: opened.generation, clientPid: process.pid, clientVersion: "1.2.7",
    platform: "darwin-arm64" };
  await storeSessionBinding(binding);
  await recordInstall({ dataHome, adapterId: "antigravity", version: "1.2.7", artifacts: [],
    deliveryPolicy: installedPolicy });
  const pushed = [];
  const relay = createRelay({ runtimeDir, socketDir: root, conversationId: CONVERSATION,
    agyPid: process.pid, clientVersion: "1.2.7", isAlive: () => true,
    api: { sendMessage: async text => { pushed.push(text); return { ok: true, reasonCode: null }; },
      conversationMetadata: async () => ({ ok: true, reasonCode: null }) } });
  await relay.listen();
  t.after(async () => { await relay.close("test_end"); await rm(root, { recursive: true, force: true }); });
  const adapter = createAntigravityAdapter();
  const activate = () => activateAntigravityRelay({ session, service, runtimeDir, dataHome, adapter });
  const bindings = () => service.listDeliveryBindings({ participantId: "antigravity", now: clock.now() });
  const turn = () => establishNativeBinding({ adapter,
    event: { kind: "beforeTurn", sessionId: CONVERSATION }, hookBinding: { ...binding },
    clientVersion: "1.2.7", platform: "darwin-arm64", livePolicy: "actionable", service,
    runtimeDir, clock, env: {} });
  return { adapter, binding, session, service, runtimeDir, relay, pushed, activate, bindings, turn };
}

test("a started relay publishes its own binding without waiting for a turn", async t => {
  const f = await fixture(t);

  const result = await f.activate();

  assert.equal(result.state, "active");
  const [published] = await f.bindings();
  assert.equal(published.opaqueEndpointRef, f.relay.endpointId);
  const attempt = await loadNativeAttempt({ runtimeDir: f.runtimeDir, harnessSessionId: CONVERSATION,
    accSessionId: f.session.sessionId, generation: f.session.generation });
  assert.equal(attempt.event, "relayReady");
  assert.equal(attempt.policySource, "installation-record");
});

test("withdrawn installation consent publishes nothing", async t => {
  const f = await fixture(t, { installedPolicy: "off" });
  assert.equal(await f.activate(), null);
  assert.deepEqual(await f.bindings(), []);
});

test("a delayed relay does not adopt a replacement owner", async t => {
  const f = await fixture(t);
  const successor = await f.service.openSession({ workspaceId: "workspace_relay",
    participantId: "successor", harness: "antigravity", heartbeatCadenceMs: 30_000 });
  await storeSessionBinding({ ...f.binding, accSessionId: successor.sessionId,
    generation: successor.generation });
  assert.equal(await f.activate(), null);
  assert.deepEqual(await f.bindings(), []);
});

test("every turn's re-handshake keeps the relay reachable", async t => {
  const f = await fixture(t);
  await f.activate();

  for (let turn = 0; turn < 2; turn += 1) assert.equal((await f.turn()).state, "active");

  assert.equal((await listRegistrations({ runtimeDir: f.runtimeDir })).length, 1,
    "the runner's retirement of the previous binding must not remove the relay");
  const [current] = await f.bindings();
  assert.equal(current.opaqueEndpointRef, f.relay.endpointId);
  const offered = await f.adapter.offerMessage({ binding: current, runtimeDir: f.runtimeDir,
    message: { messageId: "message_q1", kind: "question", subject: "Schema", body: "Does it hold?" } });
  assert.equal(offered.accepted, true);
  assert.equal(f.pushed.length, 1);
});

test("the real binary refuses in one line and exits 0 outside an agent shell", async t => {
  const binary = path.resolve("bin/acc-antigravity-relay.mjs");
  // A data home of its own: the launcher otherwise finds the managed runtime
  // installed on this machine and runs that generation instead of this checkout.
  const dataHome = await realpath(await mkdtemp("/tmp/acc-agr-bin-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const env = { ...process.env, ACC_DATA_HOME: dataHome };
  for (const name of ["ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_CONVERSATION_ID"]) {
    delete env[name];
  }
  const { stdout } = await promisify(execFile)(process.execPath, [binary, "start"], { env });
  assert.equal(stdout, "ACC: this shell has no Antigravity session endpoint; run this from an Antigravity agent.\n");
});
