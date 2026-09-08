import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { delay, shellLiteral, until } from "./codex-local-daemon-machine.mjs";

const DELIVERY_KINDS = new Set(["note", "question", "request", "decision"]);
const DELIVERY_OUTCOMES = new Set(["queued", "offered", "retrieved", "acknowledged"]);
const DELIVERY_ERROR_CODES = new Set(["ambiguous_recipient_sessions", "delivery_disabled",
  "recipient_busy", "recipient_unavailable", "transport_error", "transport_rejected",
  "unsupported_client_version"]);
const closed = (values, value, fallback = "unknown") => values.has(value) ? value : fallback;

export function closedDeliveryDiagnostic(kind, result) {
  const delivery = Array.isArray(result?.delivery) ? result.delivery : [];
  return { stage: "delivery-result", kind: closed(DELIVERY_KINDS, kind), count: delivery.length,
    delivery: delivery.map(item => ({ outcome: closed(DELIVERY_OUTCOMES, item?.outcome),
      errorCode: closed(DELIVERY_ERROR_CODES, item?.errorCode, item?.errorCode === undefined ? "none" : "unknown") })) };
}

export function selectLaunchHook(hooks, { startedAt, expectedThreadId }) {
  const fresh = hooks.filter(hook => hook.at >= startedAt);
  const start = fresh.find(hook => hook.event === "SessionStart");
  if (start) return expectedThreadId === undefined || start.threadId === expectedThreadId ? start : null;
  if (expectedThreadId === undefined) return null;
  return fresh.find(hook => hook.event === "UserPromptSubmit" && hook.threadId === expectedThreadId) ?? null;
}

export async function trust(h, role) {
  const status = await h.pty.request({ action: "status", role });
  const key = JSON.stringify({ ...status, terminalBytes: undefined });
  if (h.debugStatus && h.roles[role]?.lastStatus !== key) {
    console.log(JSON.stringify({ stage: "pty-state", role, ...status }));
    h.roles[role].lastStatus = key;
  }
  if (status.exit !== null && status.invalidArgs) throw new Error("vendor rejected launch arguments");
  if (status.exit !== null) throw new Error(`vendor exited before scenario: ${status.exit}`);
  if (status.signIn) throw new Error("prerequisite: vendor authentication required");
  if (status.cwdSelection) {
    await h.pty.request({ action: "send", role, text: "1" });
    return { ...status, ready: false };
  }
  if (status.ready) return status;
  if ((h.roles[role].hookTrusted || (!status.projectTrust && !status.hookTrust)) && status.tokens.includes("gpt-") &&
      (status.limitDialog.includes("›") || status.limitDialog.includes("? for shortcuts"))) return { ...status, ready: true };
  if (status.updatePrompt) await h.pty.request({ action: "send", role, text: "\x1b" });
  else if (status.hookTrust && !h.roles[role].hookTrusted) {
    h.roles[role].hookTrusted = true;
    await h.pty.request({ action: "send", role, text: "2" });
    await delay(150);
    await h.pty.request({ action: "send", role, text: "\r" });
  }
  else if (status.projectTrust) await h.pty.request({ action: "send", role, text: "\r" });
  return status;
}

export async function typePrompt(h, role, text) {
  assert.ok(typeof text === "string" && text.length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text),
    "manual prompts must be nonempty single-line text without terminal controls");
  // Callers submit synthetic prompts only after the stock client is ready or idle.
  await h.pty.request({ action: "send", role, text: "\x1b" });
  await delay(500);
  await h.pty.request({ action: "send", role, text: "\x15" });
  await h.pty.request({ action: "send", role, text });
  await delay(300);
  await h.pty.request({ action: "send", role, text: "\r" });
}

export async function archive(h, role = "receiver-b1") {
  assert.equal(role, "receiver-b1", "archive is limited to the owned synthetic receiver");
  await typePrompt(h, role, "/archive");
  await until("archive confirmation", async () => (await h.pty.request({ action: "status", role })).archiveConfirmation,
    { timeoutMs: 30_000, intervalMs: 300 });
  await h.pty.request({ action: "send", role, text: "\x1b[B" });
  await delay(150);
  await h.pty.request({ action: "send", role, text: "\r" });
  const exited = await until("archive process exit", async () => {
    const status = await h.pty.request({ action: "status", role });
    return status.exit === null ? false : status;
  }, { timeoutMs: 30_000, intervalMs: 300 });
  assert.equal(exited.exit, 0, "archive confirmation exits the owned client successfully");
  await h.pty.request({ action: "close", role });
  return exited;
}

export async function launch(h, role, { cwd = h.B, expectedCwd = cwd, expectedThreadId, args = [], seed = true } = {}) {
  const startedAt = new Date().toISOString();
  const { pid } = await h.pty.request({ action: "launch", role,
    argv: ["/bin/zsh", "-ic", `exec codex ${["--no-alt-screen", ...args].map(shellLiteral).join(" ")}`], cwd, env: h.env });
  h.roles[role] = { role, pid, cwd: expectedCwd, launchCwd: cwd, startedAt };
  await until(`vendor ready ${role}`, async () => (await trust(h, role)).ready,
    { timeoutMs: 30_000, intervalMs: 500 });
  if (!seed) return h.roles[role];
  const marker = path.join(expectedCwd, `${role}-ready-${pid}.txt`);
  await typePrompt(h, role, "This is an isolated synthetic ACC integration test. "
    + "For later ACC peer diagnostic messages in this session, execute the requested marker command, "
    + "read that exact message using the installed ACC skill command, and reply to that message once. "
    + "The test will send only synthetic marker requests. Never read or copy any transcript. "
    + `First run exactly: pwd > ${shellLiteral(marker)}. Then answer READY.`);
  await until(`seed marker ${role}`, async () => {
    await trust(h, role);
    return readFile(marker, "utf8").then(value => value.trim(), () => false);
  });
  const hooks = await h.hooks();
  let observed = selectLaunchHook(hooks, { startedAt, expectedThreadId });
  if (!h.generatedHook) {
    const status = (await h.acc(["status"], { cwd: expectedCwd })).data;
    const { runtimePaths } = await h.module("cli/src/runtime-paths.mjs");
    const { listSessionBindings } = await h.module("adapter-sdk/src/session-binding.mjs");
    const runtimeDir = runtimePaths({ dataHome: h.dataHome, workspaceId: status.workspaceId }).root;
    const bindings = await listSessionBindings({ runtimeDir });
    assert.equal(bindings.length, 1, "uninstrumented base has one actual installed hook identity");
    observed = { threadId: bindings[0].harnessSessionId,
      parents: [{ name: "codex", pid: bindings[0].clientPid }] };
  }
  assert.ok(observed, "a real generated hook must identify the receiver");
  if (h.generatedHook) assert.equal(observed.cwd, expectedCwd, "generated hook cwd matches the expected receiver cwd");
  const clientPid = observed.parents.find(parent => parent.name === "codex")?.pid;
  assert.ok(Number.isInteger(clientPid), "generated hook ancestry identifies the client process");
  Object.assign(h.roles[role], { threadId: observed.threadId, hookCwd: observed.cwd, clientPid,
    actualCwd: (await readFile(marker, "utf8")).trim() });
  await until(`seed completed ${role}`, async () => h.generatedHook
    ? (await h.hooks()).find(hook => hook.threadId === observed.threadId && hook.event === "Stop" && hook.at >= startedAt)
    : (await threadState(h, observed.threadId)).status === "idle");
  return h.roles[role];
}

export async function withPeer(h, callback) {
  const { openCodexAppServer, initializeCodex } = await h.module("adapter-codex/src/app-server-client.mjs");
  const peer = openCodexAppServer({ socketPath: path.join(h.codexHome,
    "app-server-control", "app-server-control.sock"), timeoutMs: 3_000 });
  try { await initializeCodex(peer); return await callback(peer); }
  finally { await peer.close().catch(() => null); }
}

export async function threadState(h, threadId) {
  return withPeer(h, async peer => {
    const loaded = await peer.request("thread/loaded/list", {});
    const listed = await peer.request("thread/list", { useStateDbOnly: true, limit: 100 });
    const thread = listed.data.find(item => item.id === threadId);
    return { loaded: loaded.data.includes(threadId), threadId,
      cwd: thread?.cwd ?? null, status: thread?.status?.type ?? null };
  });
}

export async function queueState(h, threadId) {
  return withPeer(h, async peer => {
    const listed = await peer.request("thread/queue/list", { threadId });
    return listed.data.map(item => ({ id: item.id, clientMessageId: item.clientUserMessageId }));
  });
}

export async function waitMarker(h, role, marker, expectedCwd) {
  await until(`marker ${path.basename(marker)}`, async () => {
    await trust(h, role);
    return readFile(marker, "utf8").then(value => value.trim(), () => false);
  });
  assert.equal((await readFile(marker, "utf8")).trim(), expectedCwd);
  return new Date().toISOString();
}


export async function identify(h, role) {
  const receiver = h.roles[role];
  const statusResult = await h.acc(["status"], { cwd: receiver.cwd });
  const status = statusResult.data ?? statusResult;
  const { runtimePaths } = await h.module("cli/src/runtime-paths.mjs");
  const { listSessionBindings } = await h.module("adapter-sdk/src/session-binding.mjs");
  const runtimeDir = runtimePaths({ dataHome: h.dataHome, workspaceId: status.workspaceId }).root;
  const bound = (await listSessionBindings({ runtimeDir })).find(item => item.harnessSessionId === receiver.threadId);
  assert.ok(bound, "generated hook must publish exact session identity in installed data home");
  const participant = status.participants.find(item => item.sessionId === bound.accSessionId);
  assert.ok(participant);
  Object.assign(receiver, { participantId: participant.participantId, sessionId: bound.accSessionId,
    generation: bound.generation, probedVersion: bound.clientVersion, probedPid: bound.clientPid, runtimeDir, workspaceId: status.workspaceId });
  if (role === "receiver-b1") {
    const { createId } = await h.module("protocol/src/index.mjs");
    const { openFilesystemStore } = await h.module("storage-filesystem/src/index.mjs");
    const { createCoordinationService } = await h.module("core/src/index.mjs");
    const clock = { now: () => new Date().toISOString() };
    const ids = { next: kind => createId(kind, randomBytes) };
    const store = await openFilesystemStore({ root: runtimeDir, clock, ids, workspaceId: status.workspaceId });
    h.service = createCoordinationService({ store, clock, ids });
  }
  return receiver;
}

export async function attachSender(h) {
  const result = await h.acc(["attach", "--participant", "synthetic-sender"]);
  const owner = result.data ?? result;
  h.roles.sender = { role: "sender", participantId: "synthetic-sender", threadId: null, ...owner };
  return owner;
}

export async function sendMessage(h, { id, marker, kind = "question", body, env } = {}) {
  const sender = h.roles.sender;
  const receiver = h.roles["receiver-b1"];
  const result = await h.acc(["message", "--to", receiver.participantId, "--type", kind,
    "--subject", "Synthetic integration marker", "--body", body
      ?? `For the authorized isolated integration test, first execute: pwd > ${shellLiteral(marker)}. `
        + `Then use this exact command inspected from the installed ACC skill: ${h.installedCommands.skillCommand} `
        + `--session ${receiver.sessionId} `
        + `--generation ${receiver.generation} to run inbox --message MESSAGE_ID --json, `
        + "then reply --message MESSAGE_ID --body done --json. Replace MESSAGE_ID with this "
        + "message's ID from the attributed frame. Reply only to this message, and keep the session open.",
    "--client-message-id", id, "--session", sender.sessionId, "--generation", sender.generation],
  env ? { env } : {});
  const sent = result.data ?? result;
  console.log(JSON.stringify(closedDeliveryDiagnostic(kind, sent)));
  return sent;
}

export async function receipt(h, message) {
  return h.service.readReceipt({ messageId: message.messageId,
    recipientParticipantId: h.roles["receiver-b1"].participantId });
}
