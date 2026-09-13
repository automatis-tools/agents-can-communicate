import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { controlledCodexDaemon, THREAD } from "../helpers/codex-daemon.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

// Both vendor boundaries are controlled fixtures, not a native-client capture.
// Everything between them is the installed product: Channel entrypoint, MCP
// acc_reply, durable records, installation consent, router and Codex transport.
async function fixture(t) {
  const packed = await createPackedAcc(t);
  const module = (name, file = "index") => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", `${file}.mjs`)));
  const { discoverWorkspace, createGitProbe, platformDataHome, runtimePaths } = await module("cli");
  const { createCoordinationService } = await module("core");
  const { openFilesystemStore } = await module("storage-filesystem");
  const { createId } = await module("protocol");
  const { recordInstall } = await module("installer");
  const { storeSessionBinding } = await module("adapter-sdk");
  const codex = await module("adapter-codex", "native-delivery");
  const claude = await module("adapter-claude-code", "native-delivery");
  const descriptor = await discoverWorkspace({ cwd: packed.project, env: packed.env,
    gitProbe: createGitProbe() });
  const paths = runtimePaths({ dataHome: packed.dataHome,
    workspaceId: descriptor.id, workspaceRoots: descriptor.roots });
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind, randomBytes) };
  const store = await openFilesystemStore({ root: paths.root, clock, ids, workspaceId: descriptor.id });
  const service = createCoordinationService({ store, clock, ids });
  const session = harness => service.openSession({ workspaceId: descriptor.id,
    participantId: harness, harness, heartbeatCadenceMs: 30_000 });
  const receiver = await session("codex");
  const responder = await session("claude_code");
  const daemon = await controlledCodexDaemon(t, { cwd: packed.project });
  const native = await codex.bindNativeSession({ event: { sessionId: THREAD, cwd: packed.project },
    clientPid: process.pid, clientVersion: "0.152.1", runtimeDir: paths.root, env: daemon.env });
  assert.equal(native.supported, true);
  await service.publishDeliveryBinding({ sessionId: receiver.sessionId, generation: receiver.generation,
    adapterId: "codex", clientVersion: "0.152.1", availableModes: ["livePush"], livePolicy: "all",
    opaqueEndpointRef: native.opaqueEndpointRef, leaseUntil: native.leaseUntil });
  await storeSessionBinding({ runtimeDir: paths.root, harnessSessionId: "fixture-claude",
    accSessionId: responder.sessionId, generation: responder.generation, clientPid: process.pid });
  // Supply a deterministic process ancestry without changing or replacing any
  // installed ACC module. ps is the only ownership boundary substituted here.
  const ps = path.join(packed.clientBin, "ps");
  await writeFile(ps, '#!/bin/sh\nprintf "%s %s node\\n%s 1 claude\\n" "$PPID" "$FIXTURE_CLIENT_PID" "$FIXTURE_CLIENT_PID"\n');
  await chmod(ps, 0o755);
  const child = spawn(process.execPath, [path.join(packed.installed, "bin", "acc-claude-channel.mjs")], {
    cwd: packed.project, env: { ...packed.env, FIXTURE_CLIENT_PID: String(process.pid) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  t.after(async () => { child.kill("SIGTERM"); await closed; lines.close(); });
  let id = 0;
  const notifications = [];
  const write = message => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const rpc = async (method, params = {}) => {
    const requestId = ++id;
    write({ id: requestId, method, params });
    for (;;) {
      const line = await iterator.next();
      assert.equal(line.done, false, `Channel exited before ${method}: ${stderr}`);
      const message = JSON.parse(line.value);
      if (message.id !== requestId) { notifications.push(message); continue; }
      assert.equal(message.error, undefined, JSON.stringify(message.error));
      return message.result;
    }
  };
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25" });
  assert.deepEqual(initialized.capabilities.experimental, { "claude/channel": {} });
  write({ method: "notifications/initialized" });
  const channel = await claude.bindNativeSession({ runtimeDir: paths.root,
    clientPid: process.pid, clientVersion: "2.1.260", timeoutMs: 5_000 });
  assert.equal(channel.supported, true, JSON.stringify(channel));
  const otherHome = platformDataHome({ platform: process.platform,
    env: { ...packed.env, ACC_DATA_HOME: "", XDG_DATA_HOME: "" } });
  assert.notEqual(otherHome, packed.dataHome);
  const policy = async (selected, other) => {
    for (const [dataHome, deliveryPolicy] of [[packed.dataHome, selected], [otherHome, other]]) {
      await recordInstall({ dataHome, adapterId: "codex", version: "0.152.1",
        artifacts: [], deliveryPolicy });
    }
  };
  const deliver = async key => {
    const question = await service.sendMessage({ sessionId: receiver.sessionId,
      generation: receiver.generation, clientMessageId: key, toParticipantIds: ["claude_code"],
      kind: key === "ack-only" ? "note" : "question", obligation: key === "ack-only" ? "none" : "reply",
      subject: key, body: "Reply through the Channel tool." });
    const offered = await claude.offerMessage({ runtimeDir: paths.root,
      binding: { ...channel, adapterId: "claude_code", clientVersion: "2.1.260" }, message: question });
    assert.equal(offered.accepted, true, JSON.stringify(offered));
    await rpc("ping");
    assert.equal(notifications.some(item => item.method === "notifications/claude/channel"
      && item.params.meta.message_id === question.messageId), true);
    return question;
  };
  const reply = question => rpc("tools/call", { name: "acc_reply",
    arguments: { messageId: question.messageId, body: `Answer to ${question.subject}` } });
  const answerTo = async question => (await service.sync({ scope: "full" })).snapshot.messages
    .find(message => message.inReplyTo === question.messageId);
  const receipt = (messageId, recipientParticipantId = "codex") =>
    service.readReceipt({ messageId, recipientParticipantId });
  return { daemon, service, receiver, responder, policy, deliver, reply, answerTo, receipt, rpc };
}

test("installed Claude Channel offers its MCP replies to Codex", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.policy("actionable", "off");
  const question = await f.deliver("live-reply");
  const result = await f.reply(question);
  const answer = await f.answerTo(question);
  assert.equal(answer.kind, "answer");
  assert.equal(answer.clientMessageId, `channel-reply-${question.messageId}`);
  assert.equal((await f.receipt(question.messageId, "claude_code")).state, "acknowledged");
  assert.equal((await f.receipt(answer.messageId)).state, "offered",
    "MCP acc_reply recorded an answer but never offered it to the live recipient");
  assert.equal(f.daemon.state.queue.length, 1);
  assert.equal(f.daemon.state.queue[0].clientUserMessageId, answer.messageId);
  assert.equal(f.daemon.state.queue[0].threadId, THREAD);
  assert.match(JSON.stringify(f.daemon.state.queue[0].input), /Answer to live-reply/);
  assert.equal(result.structuredContent.delivery[0].transport, "codex-app-server");
  assert.equal(result.structuredContent.delivery[0].outcome, "offered");
  const repeated = await f.reply(question);
  assert.equal((await f.answerTo(question)).messageId, answer.messageId);
  assert.equal(f.daemon.state.queue.length, 1, "retry enqueued the answer twice");
  assert.equal(repeated.structuredContent.delivery[0].outcome, "offered");

  await f.policy("off", "all");
  const disabled = await f.deliver("delivery-disabled");
  const calls = f.daemon.state.calls.length;
  const fallback = await f.reply(disabled);
  const queued = await f.answerTo(disabled);
  assert.equal((await f.receipt(queued.messageId)).state, "queued");
  assert.equal(f.daemon.state.calls.length, calls, "ignored current consent in the selected data home");
  assert.equal(fallback.structuredContent.delivery[0].errorCode, "delivery_disabled");
  assert.match(fallback.content[0].text, /queued/);

  await f.policy("actionable", "off");
  f.daemon.state.loaded = [];
  const unavailable = await f.deliver("recipient-unavailable");
  const failed = await f.reply(unavailable);
  const preserved = await f.answerTo(unavailable);
  assert.equal((await f.receipt(preserved.messageId)).state, "queued");
  assert.equal((await f.receipt(unavailable.messageId, "claude_code")).state, "acknowledged");
  assert.equal(failed.structuredContent.delivery[0].outcome, "queued");
  assert.match(failed.content[0].text, /queued/);
  assert.equal(f.daemon.state.queue.length, 1);
  f.daemon.state.loaded = [THREAD];
  await f.reply(unavailable);
  assert.equal((await f.answerTo(unavailable)).messageId, preserved.messageId);
  assert.equal((await f.receipt(preserved.messageId)).state, "offered");
  assert.equal(f.daemon.state.queue.length, 2);

  const ackOnly = await f.deliver("ack-only");
  await f.rpc("tools/call", { name: "acc_ack", arguments: { messageId: ackOnly.messageId } });
  assert.equal((await f.receipt(ackOnly.messageId, "claude_code")).state, "acknowledged");
  assert.equal(await f.answerTo(ackOnly), undefined);
  assert.equal(f.daemon.state.queue.length, 2);
});
