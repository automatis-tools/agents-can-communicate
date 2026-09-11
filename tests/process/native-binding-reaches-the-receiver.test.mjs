import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createCoordinationService } from "@agents-can-communicate/core";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

import { establishNativeBinding } from "../../packages/hook-runner/src/native-binding.mjs";
import { controlledCodexDaemon, THREAD } from "../helpers/codex-daemon.mjs";
import { createFakeIds } from "../helpers/memory-store.mjs";

// The seam this file exists for: the hook runner publishes the delivery
// binding, the Codex adapter writes the endpoint record, and the receiver
// path reads both and compares them. Every layer here is the shipped one -
// real store, real core service, real hook-runner publish, real adapter, real
// router, real socket - because the defect this guards lived precisely
// between two layers that each passed their own tests. The daemon serves a
// version the detected CLI does not report, which is the case the whole
// contract-gated release exists to support.
const SERVING = "0.153.4";
const DETECTED_CLI = "0.154.0";
const CAPTURED = "darwin-arm64";
const shortTmp = () => (process.platform === "win32" ? tmpdir() : "/tmp");

async function directory(t, prefix) {
  const created = await realpath(await mkdtemp(path.join(shortTmp(), prefix)));
  t.after(() => rm(created, { recursive: true, force: true }));
  return created;
}

async function seam(t) {
  const cwd = await directory(t, "acc-seam-cwd-");
  const root = await directory(t, "acc-seam-store-");
  const daemon = await controlledCodexDaemon(t, { cwd });
  daemon.state.version = SERVING;
  const clock = { now: () => new Date().toISOString() };
  const ids = createFakeIds();
  const workspaceId = "workspace_seam";
  const store = await openFilesystemStore({ root, clock, ids, workspaceId });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const receiver = await service.openSession({ workspaceId, participantId: "receiver",
    sessionId: "session_receiver", harness: "codex", heartbeatCadenceMs: 30_000 });
  const sender = await service.openSession({ workspaceId, participantId: "sender",
    sessionId: "session_sender", harness: "fixture", heartbeatCadenceMs: 30_000 });
  const adapter = createCodexAdapter();
  const outcome = await establishNativeBinding({
    adapter,
    event: { kind: "sessionStart", sessionId: THREAD, cwd },
    hookBinding: { accSessionId: receiver.sessionId, generation: receiver.generation,
      clientPid: process.pid },
    // What `codex --version` answered. The daemon has since moved on, and
    // only it can say what will actually serve the push.
    clientVersion: DETECTED_CLI,
    platform: CAPTURED, livePolicy: "actionable", service, runtimeDir: root,
    clock, env: daemon.env, timeoutMs: 5_000,
  });
  const bindings = await service.listDeliveryBindings({ participantId: "receiver",
    now: clock.now() });
  return { adapter, bindings, clock, cwd, daemon, outcome, receiver, root, sender, service };
}

const message = { messageId: "message_seam", kind: "question", subject: "Seam",
  body: "does the published binding reach the receiver" };

test("a binding published by the hook runner is one the Codex receiver accepts", async t => {
  const s = await seam(t);
  assert.deepEqual(s.outcome, { state: "active", reasonCode: null,
    modes: ["livePush", "idleWake", "busyQueue"] });
  assert.equal(s.bindings.length, 1);
  const [binding] = s.bindings;
  // The record names the process that will serve the push, not the binary the
  // hook happened to find on PATH.
  assert.equal(binding.clientVersion, SERVING);

  const offer = await s.adapter.offerMessage({ binding, message, runtimeDir: s.root });
  assert.equal(offer.accepted, true,
    "the receiver refused the binding its own hook runner published");
  assert.equal(offer.clientVersion, SERVING);
  assert.equal(s.daemon.state.queue.length, 1);
  assert.equal(s.daemon.state.queue[0].threadId, THREAD);
  assert.equal(s.daemon.state.queue[0].clientUserMessageId, message.messageId);
});

test("the router delivers live over that binding instead of falling back to durable", async t => {
  const s = await seam(t);
  const router = createDeliveryRouter({ service: s.service, adapters: { codex: s.adapter },
    clock: s.clock, platform: CAPTURED, readLivePolicy: async () => "actionable" });
  const sent = await s.service.sendMessage({ sessionId: s.sender.sessionId,
    generation: s.sender.generation, clientMessageId: "client_seam",
    toParticipantIds: ["receiver"], kind: "question", obligation: "reply",
    subject: "Seam", body: "does the router reach the running client",
    artifacts: [], inReplyTo: null, handoff: null });
  const [delivery] = await router.offer(sent);
  assert.deepEqual(delivery, { recipientParticipantId: "receiver", outcome: "offered",
    transport: "codex-app-server" });
  assert.equal(s.daemon.state.queue.length, 1);
});
