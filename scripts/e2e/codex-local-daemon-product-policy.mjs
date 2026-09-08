import { copyFile } from "node:fs/promises";
import path from "node:path";
import { observeHooks, shellLiteral } from "./codex-local-daemon-machine.mjs";
import { queueState, receipt, sendMessage, typePrompt, waitMarker }
  from "./codex-local-daemon-actions.mjs";
import { binding, exists, idle, settled } from "./codex-local-daemon-product-state.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";

export async function changePolicy(h, policy) {
  // Remove our observer before asking ownership-based installation to replace
  // the generated file. Rewrap the newly generated file without stale bytes.
  await copyFile(h.originalHook, h.generatedHook);
  const report = await h.install(policy);
  await observeHooks(h);
  return report;
}

export async function productPolicy(h) {
  await idle(h);
  const s = scenario(h, "P08");
  const b = h.roles["receiver-b1"];
  const noteMarker = path.join(h.B, "actionable-note.txt");
  const note = await sendMessage(h, { id: "policy_actionable_note", kind: "note", marker: noteMarker });
  s.equal(note.delivery[0].outcome, "queued");
  s.equal((await receipt(h, note.message)).state, "queued");
  s.equal((await queueState(h, b.threadId)).some(item => item.clientMessageId === note.message.messageId), false);
  s.equal(await exists(noteMarker), false);
  const question = await sendMessage(h, { id: "policy_actionable_question", marker: path.join(h.B, "actionable-question.txt") });
  s.equal(question.delivery[0].outcome, "offered");
  await waitMarker(h, "receiver-b1", path.join(h.B, "actionable-question.txt"), h.B);
  await settled(h, question.message);
  await changePolicy(h, "all");
  const all = await sendMessage(h, { id: "policy_all_note", kind: "note", marker: path.join(h.B, "all-note.txt") });
  s.equal(all.delivery[0].outcome, "offered");
  await waitMarker(h, "receiver-b1", path.join(h.B, "all-note.txt"), h.B);
  await settled(h, all.message);
  s.check(h.daemonPids.includes(b.clientPid), "policy change did not replace the daemon");
  process.kill(b.clientPid, 0);
  s.fact("policy", "observed"); s.fact("receipt", "queued"); s.fact("receipt", "offered");
  s.fact("daemon", "unchanged", "daemon-a"); s.finish();
  await changePolicy(h, "actionable");
}

export async function productPolicyOff(h) {
  await idle(h);
  const freshMarker = path.join(h.B, "before-policy-off.txt");
  await typePrompt(h, "receiver-b1", `Run only: pwd > ${shellLiteral(freshMarker)}. Answer DONE and keep the session open.`);
  await waitMarker(h, "receiver-b1", freshMarker, h.B); await idle(h);
  const s = scenario(h, "P09");
  const b = h.roles["receiver-b1"];
  const old = await binding(h);
  s.check(old && !old.retiredAt && Date.parse(old.leaseUntil) > Date.now() + 15_000);
  await changePolicy(h, "off");
  const marker = path.join(h.B, "disabled-marker.txt");
  const sent = await sendMessage(h, { id: "policy_off", marker });
  s.check(Date.now() < Date.parse(old.leaseUntil), "off is tested before the previous lease expires");
  s.equal(sent.delivery[0].outcome, "queued");
  s.equal((await receipt(h, sent.message)).state, "queued");
  s.equal((await queueState(h, b.threadId)).some(item => item.clientMessageId === sent.message.messageId), false);
  s.equal(await exists(marker), false);
  const normal = path.join(h.B, "disabled-normal-hook.txt");
  await typePrompt(h, "receiver-b1", `Run only: pwd > ${shellLiteral(normal)}. Answer DONE, keep the session open.`);
  await waitMarker(h, "receiver-b1", normal, h.B); await idle(h);
  const retired = await binding(h);
  s.check(retired === null || retired.retiredAt !== null);
  process.kill(b.clientPid, 0);
  s.fact("policy", "disabled"); s.fact("receipt", "queued"); s.fact("binding", "retired");
  s.fact("daemon", "running", "daemon-a"); s.finish();
}

export async function productUninstall(h) {
  await changePolicy(h, "actionable");
  const marker = path.join(h.B, "pre-uninstall-hook.txt");
  await typePrompt(h, "receiver-b1", `Run only: pwd > ${shellLiteral(marker)}. Answer DONE and keep the session open.`);
  await waitMarker(h, "receiver-b1", marker, h.B); await idle(h);
  const s = scenario(h, "P19");
  const old = await binding(h);
  s.check(old && !old.retiredAt && Date.parse(old.leaseUntil) > Date.now() + 15_000);
  await copyFile(h.originalHook, h.generatedHook);
  const result = (await h.acc(["uninstall", "--adapter", "codex"])).data;
  s.equal(result.failed, []);
  const sent = await sendMessage(h, { id: "after_uninstall", marker: path.join(h.B, "uninstalled-marker.txt") });
  s.check(Date.now() < Date.parse(old.leaseUntil));
  s.equal(sent.delivery[0].outcome, "queued");
  s.equal((await receipt(h, sent.message)).state, "queued");
  s.equal((await queueState(h, h.roles["receiver-b1"].threadId))
    .some(item => item.clientMessageId === sent.message.messageId), false);
  s.equal(await exists(path.join(h.B, "uninstalled-marker.txt")), false);
  s.equal(await exists(h.generatedHook), false);
  const { readInstalledLivePolicy } = await h.module("installer/src/live-policy.mjs");
  s.equal(await readInstalledLivePolicy({ dataHome: h.dataHome, adapterId: "codex" }), "off");
  process.kill(h.roles["receiver-b1"].clientPid, 0);
  s.fact("consent", "removed"); s.fact("receipt", "queued");
  s.fact("daemon", "running", "daemon-a"); s.finish();
}
