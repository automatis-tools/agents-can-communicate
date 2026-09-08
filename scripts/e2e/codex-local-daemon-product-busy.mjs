import path from "node:path";
import { stat } from "node:fs/promises";
import { shellLiteral, until } from "./codex-local-daemon-machine.mjs";
import { queueState, receipt, sendMessage, threadState, typePrompt, waitMarker }
  from "./codex-local-daemon-actions.mjs";
import { events, exists, idle, settled, snapshot } from "./codex-local-daemon-product-state.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";

export async function productBusy(h) {
  await idle(h);
  const b = h.roles["receiver-b1"];
  const s = scenario(h, "P05");
  const startMarker = path.join(h.B, "busy-started.txt");
  const mainMarker = path.join(h.B, "busy-main.txt");
  const followMarker = path.join(h.B, "busy-followup.txt");
  await typePrompt(h, "receiver-b1", `Run exactly one shell command, waiting for completion: `
    + `pwd > ${shellLiteral(startMarker)}; sleep 20; pwd > ${shellLiteral(mainMarker)}. Then answer MAIN DONE. Keep this session open.`);
  await until("long shell command has begun", () => exists(startMarker));
  const preTool = (await h.hooks()).find(item => item.threadId === b.threadId
    && item.event === "PreToolUse" && item.at >= s.record.timestamps.startedAt);
  s.check(preTool);
  s.equal((await threadState(h, b.threadId)).status, "active");
  s.equal(await exists(mainMarker), false);
  s.record.timestamps.preToolUseAt = preTool.at;
  s.fact("session-state", "active");
  const d = scenario(h, "P07");
  const input = { id: "product_busy", marker: followMarker };
  const sent = await sendMessage(h, input);
  s.equal(sent.delivery[0].outcome, "offered");
  s.record.timestamps.queuedAt = new Date().toISOString();
  const pending = () => queueState(h, b.threadId).then(items =>
    items.filter(item => item.clientMessageId === sent.message.messageId));
  s.equal((await pending()).length, 1);
  s.equal(await exists(mainMarker), false, "submission is pending inside the actual long shell command");
  const retry = await sendMessage(h, input);
  d.equal(retry.message.messageId, sent.message.messageId);
  d.equal((await pending()).length, 1);
  s.fact("queue", "pending");
  await waitMarker(h, "receiver-b1", mainMarker, h.B);
  await waitMarker(h, "receiver-b1", followMarker, h.B);
  const mainInfo = await stat(mainMarker, { bigint: true });
  const followInfo = await stat(followMarker, { bigint: true });
  s.check(mainInfo.mtimeNs < followInfo.mtimeNs, "actual main marker precedes automatic follow-up marker");
  const hooks = await h.hooks();
  const stop = hooks.find(item => item.threadId === b.threadId && item.event === "Stop" && item.at > preTool.at);
  const next = hooks.find(item => item.threadId === b.threadId && item.event === "UserPromptSubmit" && item.at >= stop?.at);
  s.check(stop && next && s.record.timestamps.queuedAt < stop.at);
  s.record.timestamps.stopAt = stop.at; s.record.timestamps.nextTurnAt = next.at;
  s.fact("marker-order", "before", "receiver-b1", "receiver-b1"); s.finish();
  await settled(h, sent.message);
  const after = await sendMessage(h, input);
  d.equal(after.message.messageId, sent.message.messageId);
  d.equal((await pending()).length, 0);
  const state = await snapshot(h);
  d.equal(state.messages.filter(item => item.clientMessageId === input.id).length, 1);
  d.equal(state.messages.filter(item => item.inReplyTo === sent.message.messageId).length, 1);
  d.equal((await events(h)).filter(item => item.type === "message.offer_succeeded"
    && item.payload.messageId === sent.message.messageId).length, 1);
  d.equal((await receipt(h, sent.message)).state, "acknowledged");
  d.fact("message", "one"); d.fact("queue", "one"); d.fact("answer", "one"); d.finish();
}

export async function productNextTurn(h) {
  await idle(h);
  const s = scenario(h, "P17");
  const b = h.roles["receiver-b1"];
  const before = (await events(h)).filter(item => item.type === "message.offer_succeeded"
    && item.payload.messageId === h.idleMessage.messageId).length;
  const note = await sendMessage(h, { id: "uncertified_next_turn", kind: "note",
    body: "Synthetic durable inbox retrieval probe; acknowledge only when explicitly asked." });
  s.equal(note.delivery[0].outcome, "queued");
  const marker = path.join(h.B, "next-normal-turn.txt");
  await typePrompt(h, "receiver-b1", `Run exactly: pwd > ${shellLiteral(marker)}. Answer DONE and keep the session open.`);
  await waitMarker(h, "receiver-b1", marker, h.B); await idle(h);
  const journal = await events(h);
  s.equal(journal.filter(item => item.type === "message.offer_succeeded"
    && item.payload.messageId === h.idleMessage.messageId).length, before);
  s.equal(journal.filter(item => item.type === "message.offer_succeeded"
    && item.payload.messageId === note.message.messageId).length, 0, "uncertified next-turn hook cannot claim offered");
  const inbox = (await h.acc(["inbox", "--message", note.message.messageId,
    "--session", b.sessionId, "--generation", b.generation])).data;
  s.check(JSON.stringify(inbox).includes(note.message.messageId));
  s.equal((await receipt(h, note.message)).state, "retrieved");
  s.fact("message", "one"); s.fact("receipt", "retrieved"); s.finish();
}
