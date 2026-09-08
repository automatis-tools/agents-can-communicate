import path from "node:path";
import { readFile } from "node:fs/promises";
import { run, until } from "./codex-local-daemon-machine.mjs";
import { attachSender, identify, launch, queueState, receipt, sendMessage, threadState,
  waitMarker } from "./codex-local-daemon-actions.mjs";
import { binding, events, exists, idle, settled, snapshot } from "./codex-local-daemon-product-state.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";

export async function productSetup(h) {
  const b = await launch(h, "receiver-b1");
  const s = scenario(h, "P01");
  const state = await threadState(h, b.threadId);
  s.equal([b.hookCwd, b.actualCwd, state.cwd, state.loaded], [h.B, h.B, h.B, true],
    "ordinary launch must preserve receiver B in hooks, actual cwd and daemon metadata");
  await identify(h, "receiver-b1");
  await attachSender(h);
  // Add resolved identities once the cwd invariant has passed independently.
  s.record.roles = [{ role: "daemon-a", participantId: null, threadId: null },
    ...Object.values(h.roles).map(role => ({ role: role.role,
      participantId: role.participantId ?? null, threadId: role.threadId ?? null }))];
  s.check(h.cli.startsWith(h.prefix) && !h.cli.includes(".gitworktrees"), "CLI is from clean installed prefix");
  s.check(h.daemonAt < h.installedAt, "daemon predates install");
  s.equal([h.env.ACC_DATA_HOME, h.env.ACC_NATIVE_DELIVERY_POLICY], [undefined, undefined]);
  const daemonCwd = (await run("/usr/sbin/lsof", ["-a", "-p", String(b.clientPid), "-d", "cwd", "-Fn"]))
    .split("\n").find(line => line.startsWith("n"))?.slice(1);
  s.equal(daemonCwd, h.A, "real hook ancestor daemon works in A");
  s.check(h.daemonPids.includes(b.clientPid), "hook PID ancestry identifies the owned daemon");
  const a = (await h.acc(["status"], { cwd: h.A })).data;
  s.check(a.workspaceId !== b.workspaceId, "A and B are separate ACC workspaces");
  s.check(!a.participants.some(item => item.participantId === b.participantId));
  const registered = await binding(h);
  if (!registered) {
    const { readInstalledLivePolicy } = await h.module("installer/src/live-policy.mjs");
    console.log(JSON.stringify({ stage: "missing-binding", probedVersion: b.probedVersion,
      probedPidMatches: b.probedPid === b.clientPid,
      installedPolicy: await readInstalledLivePolicy({ dataHome: h.dataHome, adapterId: "codex" }) }));
    if (h.bindingDiagnostics) console.log(await readFile(h.bindingDiagnostics, "utf8"));
  }
  s.check(registered && !registered.retiredAt && Date.parse(registered.leaseUntil) > Date.now(),
    "real installed hook publishes live binding");
  s.equal(registered.clientVersion, h.version);
  s.fact("installed-runtime", "observed");
  for (const kind of ["workspace", "hook-cwd", "thread-cwd", "actual-cwd"]) s.fact(kind, "matched", "receiver-b1", "receiver-b1");
  s.fact("actual-cwd", "matched", "daemon-a", "daemon-a");
  s.fact("participant", "absent", "receiver-b1", "daemon-a"); s.finish();
}

export async function productIsolation(h) {
  await launch(h, "receiver-b2"); await identify(h, "receiver-b2");
  await launch(h, "unrelated-c1", { cwd: h.C }); await identify(h, "unrelated-c1");
  const s = scenario(h, "P02");
  const b = h.roles["receiver-b1"];
  s.equal(h.roles["receiver-b2"].workspaceId, b.workspaceId);
  s.check(h.roles["unrelated-c1"].workspaceId !== b.workspaceId);
  s.equal(new Set(Object.values(h.roles).filter(role => role.threadId).map(role => role.threadId)).size, 3);
  const marker = path.join(h.B, "only-b1.txt");
  const before = (await h.hooks()).length;
  const sent = await sendMessage(h, { id: "product_exact_b1", marker });
  s.equal(sent.delivery[0].outcome, "offered");
  await waitMarker(h, "receiver-b1", marker, h.B);
  const activeIds = (await h.hooks()).slice(before).filter(item => item.event === "UserPromptSubmit").map(item => item.threadId);
  s.check(activeIds.length > 0 && activeIds.every(id => id === b.threadId), "only exact B1 executes an automatic turn");
  await settled(h, sent.message);
  const state = await snapshot(h);
  s.equal(state.receipts.filter(item => item.messageId === sent.message.messageId)
    .map(item => item.recipientParticipantId), [b.participantId]);
  s.equal(await exists(path.join(h.C, "only-b1.txt")), false);
  s.equal((await queueState(h, h.roles["receiver-b2"].threadId)).length, 0);
  s.equal((await queueState(h, h.roles["unrelated-c1"].threadId)).length, 0);
  s.fact("message", "one"); s.fact("participant", "absent", "receiver-b2", "receiver-b1");
  s.fact("participant", "absent", "unrelated-c1", "receiver-b1"); s.finish();
}

export async function productIdle(h) {
  await idle(h);
  const s = scenario(h, "P03");
  const marker = path.join(h.B, "product-idle.txt");
  const sent = await sendMessage(h, { id: "product_idle", marker });
  s.equal(sent.delivery[0].outcome, "offered");
  s.check(["offered", "retrieved", "acknowledged"].includes((await receipt(h, sent.message)).state));
  await waitMarker(h, "receiver-b1", marker, h.B);
  const journal = await events(h);
  const recorded = journal.find(item => item.type === "message.recorded" && item.payload.messageId === sent.message.messageId);
  const offered = journal.find(item => item.type === "message.offer_succeeded" && item.payload.messageId === sent.message.messageId);
  s.check(recorded && offered && recorded.sequence < offered.sequence, "durable send precedes offer success");
  s.equal(offered.payload.clientVersion, h.version);
  h.idleMessage = sent.message;
  s.fact("receipt", "recorded"); s.fact("receipt", "offered"); s.finish();
}

export async function productReply(h) {
  const s = scenario(h, "P06");
  await settled(h, h.idleMessage);
  const journal = (await events(h)).filter(item => item.payload.messageId === h.idleMessage.messageId);
  const retrieved = journal.find(item => item.type === "message.retrieved");
  const acknowledged = journal.find(item => item.type === "message.acknowledged");
  s.check(retrieved && acknowledged && retrieved.sequence < acknowledged.sequence, "actual model retrieval precedes reply acknowledgement");
  const state = await snapshot(h);
  const answers = state.messages.filter(item => item.inReplyTo === h.idleMessage.messageId);
  s.equal(answers.length, 1);
  s.equal([answers[0].kind, answers[0].fromParticipantId, answers[0].toParticipantIds],
    ["answer", h.roles["receiver-b1"].participantId, [h.roles.sender.participantId]]);
  const inbox = (await h.acc(["inbox", "--session", h.roles["receiver-b1"].sessionId,
    "--generation", h.roles["receiver-b1"].generation])).data;
  s.check(!JSON.stringify(inbox).includes(h.idleMessage.messageId), "resolved obligation leaves pending inbox");
  s.fact("receipt", "retrieved"); s.fact("receipt", "acknowledged"); s.fact("answer", "one");
  s.fact("obligation", "resolved"); s.finish();
}

export async function productLongIdle(h) {
  await idle(h);
  const s = scenario(h, "P04");
  s.record.timestamps.idleSinceAt = s.record.timestamps.startedAt;
  const old = await binding(h);
  const hooksBefore = (await h.hooks()).length;
  await until("150 seconds without hook activity", async () => {
    s.equal((await h.hooks()).length, hooksBefore, "no hook heartbeat during idle");
    return Date.now() - Date.parse(s.record.timestamps.idleSinceAt) >= 150_000;
  }, { timeoutMs: 155_000, intervalMs: 10_000 });
  s.check(Date.parse(old.leaseUntil) < Date.now() - 30_000, "original lease expired at least 30 seconds ago");
  const sent = await sendMessage(h, { id: "product_long_idle", marker: path.join(h.B, "long-idle.txt") });
  s.equal(sent.delivery[0].outcome, "offered");
  const refreshed = await binding(h);
  s.check(Date.parse(refreshed.leaseUntil) > Date.parse(old.leaseUntil));
  s.check(Date.parse(refreshed.leaseUntil) <= Date.now() + 120_000);
  await waitMarker(h, "receiver-b1", path.join(h.B, "long-idle.txt"), h.B);
  s.fact("lease", "fresh"); s.fact("receipt", "offered"); s.finish();
  await settled(h, sent.message);
}
