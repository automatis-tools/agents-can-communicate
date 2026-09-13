import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// Installed hook, Channel, router and store; only the vendor's process ancestry
// and version probe are controlled. Starting MCP AFTER SessionStart returns
// reproduces the observed ordering without relying on a machine-speed delay.
test("installed Channel activates after SessionStart missed it, without a user turn",
  { timeout: 60_000 }, async t => {
    const packed = await createPackedAcc(t);
    const load = (name, file = "index") => import(pathToFileURL(path.join(packed.installed,
      "node_modules", "@agents-can-communicate", name, "src", `${file}.mjs`)));
    const { runHook } = await load("hook-runner", "runner");
    const { createClaudeCodeAdapter } = await load("adapter-claude-code", "adapter");
    const { createDeliveryRouter } = await load("delivery-router");
    const { createCoordinationService } = await load("core");
    const { openFilesystemStore } = await load("storage-filesystem");
    const { recordInstall } = await load("installer");
    const { loadNativeAttempt } = await load("adapter-sdk");
    const adapter = createClaudeCodeAdapter();
    const env = { ...packed.env, ACC_NATIVE_DELIVERY_POLICY: "actionable" };
    await recordInstall({ dataHome: packed.dataHome, adapterId: "claude_code",
      version: "2.1.270", artifacts: [], deliveryPolicy: "actionable" });
    const start = await runHook({ adapterId: "claude_code", adapters: { claude_code: adapter },
      dataHome: packed.dataHome, env, platform: "darwin-arm64",
      payload: { hook_event_name: "SessionStart", session_id: "cold-claude",
        cwd: packed.project, source: "startup" },
      readProcessTable: async () => new Map([[process.pid, { ppid: 1, comm: "claude" }]]),
      probeClientVersion: async () => "2.1.270" });
    assert.equal(start.failed, undefined, start.reason);
    assert.equal(start.nativeBinding.state, "degraded");
    const runtimeDir = start.service.store.root;
    // The hook's store has a fixed process deadline. A later sender opens its
    // own store; retaining the hook's store would make this test expire too.
    const clock = start.service.clock;
    const ids = start.service.ids;
    const store = await openFilesystemStore({ root: runtimeDir, clock, ids,
      workspaceId: start.service.store.workspaceId });
    const service = createCoordinationService({ store, clock, ids });
    const owner = await packed.findBinding("cold-claude");
    const receiver = (await service.locateSession(owner.accSessionId)).record;
    const bindings = () => service.listDeliveryBindings({ participantId: receiver.participantId,
      now: service.clock.now() });
    assert.deepEqual(await bindings(), []);

    const ps = path.join(packed.clientBin, "ps");
    await writeFile(ps, '#!/bin/sh\nprintf "%s %s node\\n%s 1 claude\\n" "$PPID" "$FIXTURE_CLIENT_PID" "$FIXTURE_CLIENT_PID"\n');
    await chmod(ps, 0o755);
    const child = spawn(process.execPath, [path.join(packed.installed, "bin", "acc-claude-channel.mjs")], {
      cwd: packed.project, env: { ...env, FIXTURE_CLIENT_PID: String(process.pid) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    const lines = readline.createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    t.after(async () => { child.kill("SIGTERM"); await closed; lines.close(); });
    const write = message => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    write({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    const initialize = JSON.parse((await iterator.next()).value);
    assert.deepEqual(initialize.result.capabilities.experimental, { "claude/channel": {} });
    write({ method: "notifications/initialized" });
    // MCP stays responsive while registration acquires the lifecycle lock.
    const deadline = Date.now() + 5_000;
    while ((await bindings()).length === 0 && Date.now() < deadline) await delay(25);

    const sender = await service.openSession({ workspaceId: receiver.workspaceId,
      participantId: "test_sender", harness: "fixture", heartbeatCadenceMs: 30_000 });
    const question = await service.sendMessage({ sessionId: sender.sessionId,
      generation: sender.generation, clientMessageId: "cold-start-question",
      toParticipantIds: [receiver.participantId],
      kind: "question", obligation: "reply", subject: "Cold start", body: "Reply from Channel." });
    const router = createDeliveryRouter({ service, adapters: { claude_code: adapter },
      clock: service.clock, platform: "darwin-arm64", readLivePolicy: async () => "actionable" });
    assert.deepEqual(await router.offer(question), [{ recipientParticipantId: receiver.participantId,
      outcome: "offered", transport: "claude-channel" }],
    "a ready Channel remained unreachable because only a later user turn could publish its binding");
    const notification = JSON.parse((await iterator.next()).value);
    assert.equal(notification.method, "notifications/claude/channel");
    assert.equal(notification.params.meta.message_id, question.messageId);
    write({ id: 2, method: "tools/call", params: { name: "acc_reply",
      arguments: { messageId: question.messageId, body: "Cold-start reply" } } });
    const reply = JSON.parse((await iterator.next()).value);
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.structuredContent.status, "recorded");
    assert.equal((await service.readReceipt({ messageId: question.messageId,
      recipientParticipantId: receiver.participantId })).state, "acknowledged");
    const diagnosticInput = { runtimeDir, harnessSessionId: "cold-claude",
      accSessionId: owner.accSessionId, generation: owner.generation };
    let diagnostic = await loadNativeAttempt(diagnosticInput);
    while (diagnostic?.event !== "channelReady" && Date.now() < deadline) {
      await delay(25);
      diagnostic = await loadNativeAttempt(diagnosticInput);
    }
    assert.equal(diagnostic.event, "channelReady");
    assert.equal(diagnostic.state, "active");
    assert.equal((await packed.findBinding("cold-claude")).generation, owner.generation);
  });
