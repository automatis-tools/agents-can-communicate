import { mkdir } from "node:fs/promises";
import path from "node:path";
import { shellLiteral, until } from "./codex-local-daemon-machine.mjs";
import { identify, launch, queueState, receipt, sendMessage, threadState, trust, typePrompt, waitMarker, withPeer }
  from "./codex-local-daemon-actions.mjs";
import { exists } from "./codex-local-daemon-product-state.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";

const remote = h => ["--remote", `unix://${path.join(h.codexHome, "app-server-control/app-server-control.sock")}`];
async function close(h, role = "receiver-b2") {
  const old = h.roles[role];
  if (!old) return;
  await h.pty.request({ action: "close", role });
  return old;
}
async function matched(h, s, expected, role = "receiver-b2") {
  const b = await identify(h, role);
  const state = await threadState(h, b.threadId);
  s.equal([b.actualCwd, b.hookCwd, state.cwd], [expected, expected, expected]);
  return b;
}

export async function productRemoteNegative(h) {
  await close(h);
  await launch(h, "receiver-b2", { cwd: h.B, expectedCwd: h.A, args: remote(h) });
  const s = scenario(h, "P12");
  const b = await matched(h, s, h.A);
  s.check(b.workspaceId !== h.roles["receiver-b1"].workspaceId);
  s.fact("actual-cwd", "matched", "daemon-a", "daemon-a");
  s.fact("workspace", "matched", "receiver-b2", "daemon-a"); s.finish();
}

export async function productExplicitModes(h) {
  await close(h, "receiver-b1");
  await launch(h, "receiver-b1", { cwd: h.C, expectedCwd: h.B, args: [...remote(h), "--cd", h.B] });
  const s = scenario(h, "P13");
  const original = await matched(h, s, h.B, "receiver-b1");
  await close(h, "receiver-b1");
  await launch(h, "receiver-b1", { cwd: h.C, expectedCwd: h.B, expectedThreadId: original.threadId,
    args: [...remote(h), "resume", original.threadId] });
  s.equal((await matched(h, s, h.B, "receiver-b1")).threadId, original.threadId);
  await close(h, "receiver-b1");
  await launch(h, "receiver-b1", { cwd: h.C, expectedCwd: h.B,
    args: [...remote(h), "fork", original.threadId] });
  s.check((await matched(h, s, h.B, "receiver-b1")).threadId !== original.threadId);
  await close(h, "receiver-b1");
  const relative = path.join(h.A, "relative receiver");
  await mkdir(relative, { recursive: true });
  await launch(h, "receiver-b1", { cwd: h.C, expectedCwd: relative,
    args: [...remote(h), "--cd", "relative receiver"] });
  await matched(h, s, relative, "receiver-b1");
  s.fact("launch-arguments", "unchanged"); s.fact("actual-cwd", "matched", "receiver-b1", "receiver-b1");
  s.finish();
}

export async function productSessionChanges(h) {
  // /cd requires prior vendor trust; establish it through the real client UI.
  if (!h.roles["unrelated-c1"]) {
    await launch(h, "unrelated-c1", { cwd: h.C });
    await identify(h, "unrelated-c1");
  }
  await close(h, "receiver-b1");
  await launch(h, "receiver-b1", { cwd: h.B });
  const old = await identify(h, "receiver-b1");
  const s = scenario(h, "P14");
  const beforeCd = new Date().toISOString();
  const loadedBefore = new Set((await withPeer(h, peer => peer.request("thread/loaded/list", {}))).data);
  await typePrompt(h, "receiver-b1", `/cd ${h.C}`);
  await until("ordinary /cd loaded a new thread", async () => {
    const status = await trust(h, "receiver-b1");
    if (status.cdBlock) throw new Error(`vendor /cd refused: ${status.cdBlock}`);
    return (await withPeer(h, peer => peer.request("thread/loaded/list", {}))).data.some(id => !loadedBefore.has(id));
  },
  { timeoutMs: 20_000 });
  const marker = path.join(h.C, "ordinary-cd.txt");
  await typePrompt(h, "receiver-b1", `Run only: pwd > ${shellLiteral(marker)}. Answer DONE and keep the session open.`);
  await waitMarker(h, "receiver-b1", marker, h.C);
  const changed = (await h.hooks()).find(item => item.event === "SessionStart" && item.at >= beforeCd
    && item.threadId !== old.threadId);
  s.check(changed, "ordinary /cd creates an observed new thread identity");
  s.equal(changed.cwd, h.C);
  s.equal((await threadState(h, changed.threadId)).cwd, h.C);
  await close(h, "receiver-b1");
  await launch(h, "receiver-b1", { cwd: h.C, expectedCwd: h.B, expectedThreadId: old.threadId,
    args: ["resume", old.threadId] });
  const resumed = await identify(h, "receiver-b1");
  s.equal(resumed.threadId, old.threadId);
  const closeAt = new Date().toISOString();
  await close(h, "receiver-b1");
  await until("real client SessionEnd", async () => (await h.hooks()).find(item =>
    item.event === "SessionEnd" && item.threadId === resumed.threadId && item.at >= closeAt));
  const retired = await h.service.store.ephemeral.get("deliveryBinding", resumed.sessionId);
  s.check(retired === null || retired.retiredAt != null);
  s.equal((await h.service.listDeliveryBindings({ participantId: resumed.participantId,
    now: new Date().toISOString(), includeExpired: true })).length, 0);
  const closedMarker = path.join(h.B, "closed-generation.txt");
  const sentClosed = await sendMessage(h, { id: "product_closed_generation", kind: "note",
    body: `For this isolated test, run only: pwd > ${shellLiteral(closedMarker)}. Keep the session open.` });
  s.equal(sentClosed.delivery[0].outcome, "queued",
    "a closed generation must refuse native delivery after durable recording");
  s.equal((await receipt(h, sentClosed.message)).state, "queued");
  s.equal((await queueState(h, resumed.threadId)).filter(item =>
    item.clientMessageId === sentClosed.message.messageId).length, 0);
  s.equal(await exists(closedMarker), false);
  await launch(h, "receiver-b1", { cwd: h.C, expectedCwd: h.B, args: ["fork", old.threadId] });
  const forked = await identify(h, "receiver-b1");
  s.check(forked.threadId !== old.threadId);
  s.check(forked.sessionId !== resumed.sessionId || forked.generation !== resumed.generation);
  s.equal(forked.actualCwd, h.B);
  s.fact("binding", "retired"); s.fact("binding", "fresh", "receiver-b1");
  s.fact("actual-cwd", "matched", "receiver-b1", "receiver-b1"); s.finish();
}
