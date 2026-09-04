import os from "node:os";
import path from "node:path";

import { openWebSocketPeer } from "./ws-json-rpc.mjs";

// The Codex App Server queue protocol, captured on codex-cli 0.152.1. Every
// method here is official and present in the generated schema: initialize,
// thread/loaded/list, thread/list, thread/queue/list, thread/queue/add. The
// client never resumes, starts, steers, or reads a thread, and never reads
// assistant transcript content. Closed safe results only; no vendor string
// escapes to core.

export const PROTOCOL_CONTRACT = "codex-app-server-thread-queue-v1";
export const MINIMUM_VERSION = "0.152.1";
export const QUEUE_MODES = Object.freeze(["livePush", "idleWake", "busyQueue"]);
const CLIENT_INFO = Object.freeze({ name: "agents-can-communicate", version: "0.2.0" });
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_PAGES = 20;
const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;

export const controlSocketPath = (env = process.env) =>
  path.join(env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "app-server-control", "app-server-control.sock");

export function parseStableVersion(text) {
  return STABLE_VERSION.test(String(text ?? "")) ? String(text).split(".").map(Number) : null;
}
export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}
export function serverVersionOf(userAgent) {
  return /^[^\s/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?=[\s(]|$)/
    .exec(String(userAgent ?? ""))?.[1] ?? null;
}
export function isMethodMissing(error) {
  return error?.code === METHOD_NOT_FOUND
    || (error?.code === INVALID_REQUEST && /unknown variant/.test(String(error?.message ?? "")));
}

export function openCodexAppServer({ socketPath, timeoutMs = 5_000 }) {
  return openWebSocketPeer({ socketPath, timeoutMs });
}

export async function initializeCodex(peer) {
  const initialized = await peer.request("initialize",
    { clientInfo: { ...CLIENT_INFO }, capabilities: { experimentalApi: true } });
  peer.notify("initialized", {});
  return serverVersionOf(initialized?.userAgent);
}

export async function probeCodexQueue(peer, { threadId, minimum = MINIMUM_VERSION }) {
  const serverVersion = await initializeCodex(peer);
  if (serverVersion === null || parseStableVersion(serverVersion) === null) {
    return { supported: false, serverVersion, reasonCode: "prerelease_not_captured" };
  }
  if (compareStableVersions(serverVersion, minimum) < 0) {
    return { supported: false, serverVersion, reasonCode: "below_minimum_version" };
  }
  try {
    await peer.request("thread/queue/list", { threadId });
  } catch (error) {
    if (isMethodMissing(error)) return { supported: false, serverVersion, reasonCode: "protocol_mismatch" };
  }
  return { supported: true, serverVersion, reasonCode: null, modes: [...QUEUE_MODES] };
}

async function pageAll(peer, method, params) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await peer.request(method, cursor === null ? params : { ...params, cursor });
    items.push(...(response?.data ?? []));
    cursor = response?.nextCursor ?? null;
    if (cursor === null) break;
  }
  return items;
}

const listParams = cwd => ({ limit: 100, useStateDbOnly: true, ...(cwd ? { cwd } : {}) });

export async function locateCodexThread(peer, { threadId, cwd }) {
  const loaded = await pageAll(peer, "thread/loaded/list", {});
  if (!loaded.includes(threadId)) return { found: false, reasonCode: "thread_not_loaded" };
  const threads = await pageAll(peer, "thread/list", listParams(cwd));
  const found = threads.find(item => item?.id === threadId);
  if (!found) return { found: false, reasonCode: "thread_not_found" };
  if (cwd !== undefined && found.cwd !== cwd) return { found: false, reasonCode: "cwd_mismatch" };
  return { found: true, threadId, status: found.status?.type ?? "unknown" };
}

// thread/queue/list first, so a retried client message id is the same offer
// while the submission is still queued; the ACC message id is the stable
// clientUserMessageId.
export async function addCodexQueueMessage(peer, { threadId, messageId, text }) {
  const listed = await peer.request("thread/queue/list", { threadId });
  const existing = (listed?.data ?? []).find(item => item?.clientUserMessageId === messageId);
  if (existing) {
    return { accepted: true, duplicate: true, queuedSubmissionId: existing.id };
  }
  const added = await peer.request("thread/queue/add", { threadId,
    input: [{ type: "text", text }], clientUserMessageId: messageId });
  const submission = added?.queuedSubmission;
  if (!submission || submission.clientUserMessageId !== messageId) {
    throw Object.assign(new Error("queue acknowledgement did not echo the client message id"),
      { code: "EPROTOCOL" });
  }
  return { accepted: true, duplicate: false, queuedSubmissionId: submission.id };
}

export function safeReason(error) {
  const message = String(error?.message ?? "");
  if (isMethodMissing(error) || error?.code === "EPROTOCOL") return "protocol_mismatch";
  if (error?.code === "ETIMEDOUT" || /timed out/.test(message)) return "request_timeout";
  if (["ECONNREFUSED", "ENOENT", "EPIPE"].includes(error?.code)
    || /WebSocket (?:handshake|peer)|ECONNREFUSED|ENOENT/.test(message)) return "transport_unavailable";
  return "vendor_error";
}
