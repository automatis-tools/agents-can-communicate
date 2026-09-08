// Narrow real installed-adapter transport proof. Positive product captures use
// the ACC router instead; these direct method calls cannot certify that path.
import path from "node:path";
import { delay, shellLiteral, until } from "./codex-local-daemon-machine.mjs";
import { attachSender, identify, launch, queueState, receipt, sendMessage, threadState,
  typePrompt, waitMarker } from "./codex-local-daemon-actions.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";

export async function transportScenarios(h) {
  await launch(h, "receiver-b1");
  const receiver = await identify(h, "receiver-b1");
  await attachSender(h);
  const native = await h.module("adapter-codex/src/native-delivery.mjs");
  const input = { event: { sessionId: receiver.threadId, cwd: receiver.cwd },
    clientPid: receiver.clientPid, clientVersion: h.version, runtimeDir: receiver.runtimeDir,
    env: h.env, timeoutMs: 3_000 };
  const exact = scenario(h, "T01");
  const state = await threadState(h, receiver.threadId);
  exact.equal([state.loaded, state.cwd, receiver.hookCwd, receiver.actualCwd],
    [true, h.B, h.B, h.B]);
  exact.check(Number.isInteger(receiver.clientPid), "real daemon PID must be identified");
  const handshake = await native.bindNativeSession(input);
  exact.equal(handshake.supported, true);
  const wrongCwd = await native.bindNativeSession({ ...input,
    event: { sessionId: receiver.threadId, cwd: h.A } });
  exact.equal([wrongCwd.supported, wrongCwd.opaqueEndpointRef, wrongCwd.modes,
    wrongCwd.reasonCode], [false, null, [], "workspace_identity_unavailable"],
  "same Codex thread must reject A cwd");
  const binding = { opaqueEndpointRef: handshake.opaqueEndpointRef, clientVersion: h.version };
  exact.fact("binding", "matched", "receiver-b1", "receiver-b1"); exact.finish();
  const offer = message => native.offerMessage({ binding, message, runtimeDir: receiver.runtimeDir });

  const idle = scenario(h, "T02");
  await until("idle receiver", async () => (await threadState(h, receiver.threadId)).status === "idle");
  const idleMarker = path.join(h.B, "transport-idle.txt");
  const idleSend = await sendMessage(h, { id: "transport_idle", marker: idleMarker });
  idle.equal(idleSend.delivery[0].outcome, "queued", "transport proof starts from durable inbox");
  idle.equal((await offer(idleSend.message)).accepted, true);
  await waitMarker(h, "receiver-b1", idleMarker, h.B);
  idle.fact("submission", "accepted"); idle.finish();
  await until("idle turn Stop", async () => (await threadState(h, receiver.threadId)).status === "idle");

  const busy = scenario(h, "T03");
  const mainMarker = path.join(h.B, "transport-main.txt");
  const followMarker = path.join(h.B, "transport-followup.txt");
  await typePrompt(h, "receiver-b1", `Run exactly this single shell command and wait for completion: sleep 20; pwd > ${shellLiteral(mainMarker)}. Then answer MAIN DONE.`);
  const preTool = await until("busy PreToolUse", async () => (await h.hooks()).find(item =>
    item.threadId === receiver.threadId && item.event === "PreToolUse"
    && item.at >= busy.record.timestamps.startedAt));
  await until("active receiver tool", async () => (await threadState(h, receiver.threadId)).status === "active");
  busy.record.timestamps.preToolUseAt = preTool.at;
  busy.fact("session-state", "active");
  const follow = await sendMessage(h, { id: "transport_busy", marker: followMarker });
  busy.equal((await offer(follow.message)).accepted, true);
  busy.record.timestamps.queuedAt = new Date().toISOString();
  const pending = await queueState(h, receiver.threadId);
  busy.equal(pending.filter(item => item.clientMessageId === follow.message.messageId).length, 1);
  busy.check(!(await h.hooks()).some(item => item.threadId === receiver.threadId && item.event === "Stop"
    && item.at > preTool.at), "queue submission must precede main Stop");
  busy.fact("queue", "pending");
  busy.equal((await offer(follow.message)).accepted, true);
  busy.equal((await queueState(h, receiver.threadId)).filter(item => item.clientMessageId === follow.message.messageId).length, 1);
  const mainAt = await waitMarker(h, "receiver-b1", mainMarker, h.B);
  const followAt = await waitMarker(h, "receiver-b1", followMarker, h.B);
  busy.check(mainAt <= followAt, "main marker precedes queued marker");
  const hooks = await h.hooks();
  const stop = hooks.find(item => item.threadId === receiver.threadId && item.event === "Stop" && item.at > preTool.at);
  const nextTurn = hooks.find(item => item.threadId === receiver.threadId && item.event === "UserPromptSubmit" && item.at >= stop?.at);
  busy.check(stop && nextTurn && busy.record.timestamps.queuedAt < stop.at, "queue then Stop then automatic next turn");
  busy.record.timestamps.stopAt = stop.at; busy.record.timestamps.nextTurnAt = nextTurn.at;
  busy.fact("submission", "accepted"); busy.finish();

  const fallback = scenario(h, "T04");
  const recorded = await sendMessage(h, { id: "transport_fallback", kind: "note", body: "Synthetic durable fallback probe." });
  const rejected = await native.offerMessage({ binding: { ...binding, opaqueEndpointRef: "missing_endpoint" },
    message: recorded.message, runtimeDir: receiver.runtimeDir });
  fallback.equal(rejected.accepted, false);
  fallback.equal((await receipt(h, recorded.message)).state, "queued");
  fallback.fact("submission", "rejected"); fallback.fact("receipt", "queued"); fallback.finish();
  await delay(100);
}
