import os from "node:os";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";

import { openWebSocketPeer } from "./ws-json-rpc.mjs";

// The Codex App Server queue protocol, captured on codex-cli 0.152.1. Every
// method here is official and present in the generated schema: initialize,
// thread/loaded/list, thread/list, metadata-only thread/read, thread/queue/list,
// thread/queue/add. Thread history is never requested; metadata reads explicitly
// exclude turns. Closed safe results only; no vendor string escapes to core.

export const PROTOCOL_CONTRACT = "codex-app-server-thread-queue-v1";
export const MINIMUM_VERSION = "0.152.1";
// The captured native-delivery contract's floor. Shared with MINIMUM_VERSION
// today, but named separately: this is the version a binding was verified
// against, not the probe's own support floor.
export const CODEX_QUEUE_MINIMUM = MINIMUM_VERSION;
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
  return openWebSocketPeer({ socketPath, timeoutMs, retainNotifications: false });
}

export async function initializeCodex(peer) {
  const initialized = await peer.request("initialize",
    { clientInfo: { ...CLIENT_INFO }, capabilities: { experimentalApi: true } });
  peer.notify("initialized", {});
  return serverVersionOf(initialized?.userAgent);
}

export async function probeCodexQueue(peer, { threadId, minimum = MINIMUM_VERSION } = {}) {
  const serverVersion = await initializeCodex(peer);
  if (serverVersion === null || parseStableVersion(serverVersion) === null) {
    return { supported: false, serverVersion, reasonCode: "prerelease_not_captured" };
  }
  if (compareStableVersions(serverVersion, minimum) < 0) {
    return { supported: false, serverVersion, reasonCode: "below_minimum_version" };
  }
  try {
    if (threadId === undefined) {
      const loaded = await pageAll(peer, "thread/loaded/list", {});
      threadId = loaded.find(id => typeof id === "string" && id !== "");
      if (threadId === undefined) return { supported: false, serverVersion,
        reasonCode: "native_session_unavailable" };
    }
    queueEntries(await peer.request("thread/queue/list", { threadId }));
  } catch (error) {
    return { supported: false, serverVersion, reasonCode: error?.code === "ETIMEDOUT"
      ? "probe_timeout" : "protocol_mismatch" };
  }
  return { supported: true, serverVersion, reasonCode: null, modes: [...QUEUE_MODES] };
}

async function pageAll(peer, method, params) {
  const items = [];
  let cursor = null;
  const cursors = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await peer.request(method, cursor === null ? params : { ...params, cursor });
    if (!Array.isArray(response?.data)) throw protocolError();
    items.push(...response.data);
    cursor = response?.nextCursor ?? null;
    if (cursor === null) return items;
    if (typeof cursor !== "string" || cursor === "" || cursors.has(cursor)) throw protocolError();
    cursors.add(cursor);
  }
  throw protocolError();
}

const protocolError = () => Object.assign(new Error("invalid queue protocol response"),
  { code: "EPROTOCOL" });

function queueEntries(response) {
  if (!Array.isArray(response?.data) || response.data.some(item => typeof item?.id !== "string"
    || item.id === "" || (item.clientUserMessageId != null
      && typeof item.clientUserMessageId !== "string"))) throw protocolError();
  return response.data;
}

function threadEntries(items) {
  if (items.some(item => item === null || typeof item !== "object" || Array.isArray(item)
    || typeof item.id !== "string" || item.id === "")) throw protocolError();
  return items;
}

export async function canonicalCwd(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) return null;
  try {
    const resolved = await realpath(cwd);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch { return null; }
}

export async function locateCodexThread(peer, { threadId, cwd }) {
  const loaded = await pageAll(peer, "thread/loaded/list", {});
  if (!loaded.includes(threadId)) return { found: false, reasonCode: "thread_not_loaded" };
  // Filter locally after canonicalization: a server-side lexical cwd filter
  // would hide a thread recorded through a symlink to the same directory.
  const threads = threadEntries(await pageAll(peer, "thread/list",
    { limit: 100, useStateDbOnly: true }));
  const matches = threads.filter(item => item.id === threadId);
  let found = matches.length === 1 ? matches[0] : null;
  if (matches.length === 0) {
    // A real first SessionStart/UserPromptSubmit runs before persistence has
    // materialized the thread. The loaded ID still has an authoritative live
    // metadata snapshot; includeTurns:false never asks for conversation history.
    const response = await peer.request("thread/read", { threadId, includeTurns: false });
    const metadata = response?.thread;
    if (metadata?.id === threadId && Array.isArray(metadata.turns) && metadata.turns.length === 0) {
      found = metadata;
    }
  }
  if (!found) return { found: false, reasonCode: "thread_not_found" };
  const actualCwd = await canonicalCwd(found.cwd);
  if (actualCwd === null || (cwd !== undefined && actualCwd !== await canonicalCwd(cwd))) {
    return { found: false, reasonCode: "cwd_mismatch" };
  }
  const status = found.status?.type;
  if (!["idle", "active"].includes(status)) return { found: false, reasonCode: "thread_not_loaded" };
  return { found: true, threadId, cwd: actualCwd, status };
}

// thread/queue/list first, so a retried client message id is the same offer
// while the submission is still queued; the ACC message id is the stable
// clientUserMessageId.
export async function addCodexQueueMessage(peer, { threadId, messageId, text }) {
  const listed = await peer.request("thread/queue/list", { threadId });
  const existing = queueEntries(listed).find(item => item.clientUserMessageId === messageId);
  if (existing) {
    return { accepted: true, duplicate: true, queuedSubmissionId: existing.id };
  }
  const added = await peer.request("thread/queue/add", { threadId,
    input: [{ type: "text", text }], clientUserMessageId: messageId });
  const submission = added?.queuedSubmission;
  if (!submission || typeof submission.id !== "string" || submission.id === ""
    || submission.clientUserMessageId !== messageId) {
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
