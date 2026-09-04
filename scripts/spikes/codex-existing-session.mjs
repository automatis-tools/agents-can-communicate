#!/usr/bin/env node
// Disposable Codex App Server queue probe for the native-delivery capture.
//
// Talks to the vendor-owned daemon over its control Unix socket, which answers
// an HTTP upgrade and then speaks JSON-RPC one message per WebSocket text frame
// (observed on 0.152.1), and only through official methods present in the
// 0.152.1 generated schema:
// initialize, thread/loaded/list, thread/list, thread/queue/list, and
// thread/queue/add. It never resumes, starts, steers, or reads a thread, and it
// prints one closed JSON result with ids, versions, states, and a timestamp -
// never a preview, prompt, transcript, path, or raw vendor error.
//
// Captured shape (codex-app-server-thread-queue-v1):
//   thread/queue/add { threadId, input: [{ type: "text", text }], clientUserMessageId }
//   -> { queuedSubmission: { id, clientUserMessageId, input } }

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openWebSocketPeer } from "./ws-unix-peer.mjs";

export const PROTOCOL_CONTRACT = "codex-app-server-thread-queue-v1";
export const MINIMUM_VERSION = "0.152.1";
export const QUEUE_MODES = Object.freeze(["livePush", "idleWake", "busyQueue"]);
const CLIENT_INFO = Object.freeze({ name: "acc-native-delivery-capture", version: "0.0.0" });
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_PAGES = 20;
const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// Observed on 0.152.1: an unknown method is answered as -32600 "Invalid
// request: unknown variant `x`", not as -32601.
export function isMethodMissing(error) {
  return error?.code === METHOD_NOT_FOUND
    || (error?.code === INVALID_REQUEST && /unknown variant/.test(String(error?.message ?? "")));
}

export function compareStableVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function evaluateClientVersion(observed, minimum = MINIMUM_VERSION) {
  if (typeof observed !== "string" || observed === "" || observed === "unavailable") {
    return { ok: false, reasonCode: "version_unavailable" };
  }
  if (!STABLE_VERSION.test(observed)) return { ok: false, reasonCode: "prerelease_not_captured" };
  if (compareStableVersions(observed, minimum) < 0) {
    return { ok: false, reasonCode: "below_minimum_version" };
  }
  return { ok: true, reasonCode: null };
}

// Observed shape: "<clientName>/<appServerVersion> (<os>) <terminal> (<clientName>; <clientVersion>)".
export function serverVersionOf(userAgent) {
  return /^[^\s/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?=[\s(]|$)/
    .exec(String(userAgent ?? ""))?.[1] ?? null;
}

export async function probeCodexQueue(peer, { clientVersion, threadId, minimum = MINIMUM_VERSION }) {
  const base = { supported: false, clientVersion, serverVersion: null,
    protocolContract: PROTOCOL_CONTRACT, modes: [], reasonCode: null };
  const client = evaluateClientVersion(clientVersion, minimum);
  if (!client.ok) return { ...base, reasonCode: client.reasonCode };
  const initialized = await peer.request("initialize",
    { clientInfo: { ...CLIENT_INFO }, capabilities: { experimentalApi: true } });
  const serverVersion = serverVersionOf(initialized?.userAgent);
  const server = evaluateClientVersion(serverVersion ?? "unavailable", minimum);
  if (!server.ok) return { ...base, serverVersion, reasonCode: server.reasonCode };
  if (serverVersion !== clientVersion) {
    return { ...base, serverVersion, reasonCode: "server_version_mismatch" };
  }
  peer.notify("initialized", {});
  try {
    await peer.request("thread/queue/list", { threadId });
  } catch (error) {
    if (isMethodMissing(error)) return { ...base, serverVersion, reasonCode: "protocol_mismatch" };
    // Any other answer (invalid or unknown thread id) proves the method exists;
    // the thread itself is checked later.
  }
  return { ...base, supported: true, serverVersion, modes: [...QUEUE_MODES] };
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

// The state-db listing answers in milliseconds and filters by cwd; the default
// listing reads every rollout from disk (measured: 2.7 s for 20 threads).
const listParams = (cwd) => ({ limit: 100, useStateDbOnly: true, ...(cwd ? { cwd } : {}) });

export async function locateCodexThread(peer, { threadId, cwd }) {
  const loaded = await pageAll(peer, "thread/loaded/list", {});
  if (!loaded.includes(threadId)) return { found: false, reasonCode: "thread_not_loaded" };
  const threads = await pageAll(peer, "thread/list", listParams(cwd));
  const found = threads.find((item) => item?.id === threadId);
  if (!found) return { found: false, reasonCode: "thread_not_found" };
  if (found.cwd !== cwd) return { found: false, reasonCode: "cwd_mismatch" };
  return { found: true, threadId, status: found.status?.type ?? "unknown" };
}

// Loaded threads only, with id, cwd, and status - never a preview or a turn.
export async function discoverCodexThreads(peer) {
  const loaded = new Set(await pageAll(peer, "thread/loaded/list", {}));
  if (loaded.size === 0) return [];
  const threads = await pageAll(peer, "thread/list", listParams());
  return threads.filter((item) => loaded.has(item?.id)).map((item) => ({
    threadId: item.id, cwd: item.cwd ?? null, status: item.status?.type ?? "unknown",
  }));
}

export async function addCodexQueueMessage(peer, { threadId, messageId, text }) {
  const listed = await peer.request("thread/queue/list", { threadId });
  const existing = (listed?.data ?? []).find((item) => item?.clientUserMessageId === messageId);
  if (existing) {
    return { accepted: true, duplicate: true, queuedSubmissionId: existing.id,
      clientUserMessageId: messageId };
  }
  const added = await peer.request("thread/queue/add", {
    threadId,
    input: [{ type: "text", text }],
    clientUserMessageId: messageId,
  });
  const submission = added?.queuedSubmission;
  if (!submission || submission.clientUserMessageId !== messageId) {
    throw Object.assign(new Error("queue acknowledgement did not echo the client message id"),
      { code: "EPROTOCOL" });
  }
  return { accepted: true, duplicate: false, queuedSubmissionId: submission.id,
    clientUserMessageId: messageId };
}

export function safeReason(error) {
  const message = String(error?.message ?? "");
  if (isMethodMissing(error) || error?.code === "EPROTOCOL") return "protocol_mismatch";
  if (error?.code === "ETIMEDOUT" || /timed out/.test(message)) return "request_timeout";
  if (["ECONNREFUSED", "ENOENT", "EPIPE"].includes(error?.code)
    || /JSON-RPC peer (?:exited|is closed|wrote invalid JSON)|ECONNREFUSED|ENOENT/.test(message)) {
    return "transport_unavailable";
  }
  if ((error?.code === INVALID_PARAMS || error?.code === INVALID_REQUEST
    || error?.code === INTERNAL_ERROR) && /thread/i.test(message)) return "thread_not_found";
  return "vendor_error";
}

export function closedResult(clientVersion, overrides = {}, clock = () => new Date().toISOString()) {
  return { at: clock(), supported: false, clientVersion, serverVersion: null,
    protocolContract: PROTOCOL_CONTRACT, modes: [], threadId: null, threadStatus: null,
    queue: null, reasonCode: null, stage: null, ...overrides };
}

export async function runCodexQueueCapture({ peer, clientVersion, threadId, cwd, messageId, text,
  minimum = MINIMUM_VERSION, clock = () => new Date().toISOString() }) {
  const result = closedResult(clientVersion, {}, clock);
  const version = evaluateClientVersion(clientVersion, minimum);
  if (!version.ok) return { ...result, reasonCode: version.reasonCode, stage: "version" };
  let stage = "initialize";
  try {
    const probe = await probeCodexQueue(peer, { clientVersion, threadId, minimum });
    result.serverVersion = probe.serverVersion;
    if (!probe.supported) return { ...result, reasonCode: probe.reasonCode, stage: "probe" };
    stage = "locate";
    const located = await locateCodexThread(peer, { threadId, cwd });
    if (!located.found) return { ...result, reasonCode: located.reasonCode, stage };
    result.threadId = located.threadId;
    result.threadStatus = located.status;
    stage = "queue";
    const queue = await addCodexQueueMessage(peer, { threadId, messageId, text });
    return { ...result, supported: true, modes: [...QUEUE_MODES], queue, stage: "complete" };
  } catch (error) {
    return { ...result, reasonCode: safeReason(error), stage };
  }
}

function readVersion(command) {
  const run = spawnSync(command, ["--version"], { encoding: "utf8" });
  return /codex-cli\s+(\S+)/.exec(run.stdout ?? "")?.[1] ?? "unavailable";
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === "--discover") return { discover: true };
  const parsed = {};
  const known = new Set(["--thread", "--message", "--cwd", "--text"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!known.has(key) || typeof value !== "string" || value === "") usage();
    parsed[key.slice(2)] = value;
  }
  if (!parsed.thread || !parsed.message || !parsed.cwd || !path.isAbsolute(parsed.cwd)) usage();
  return parsed;
}

function usage() {
  process.stderr.write("usage: codex-existing-session.mjs --thread <exact-id> --message <stable-id> "
    + "--cwd <absolute-path> [--text <body>] | --discover\n");
  process.exit(2);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = process.env.ACC_CODEX_SPIKE_COMMAND ?? "codex";
  const minimum = process.env.ACC_CODEX_MINIMUM ?? MINIMUM_VERSION;
  const socketPath = process.env.ACC_CODEX_APP_SERVER_SOCKET
    ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
      "app-server-control", "app-server-control.sock");
  const clientVersion = readVersion(command);
  const input = { clientVersion, threadId: options.thread, cwd: options.cwd,
    messageId: options.message, text: options.text ?? "ACC native delivery capture probe.",
    minimum };
  const version = evaluateClientVersion(clientVersion, minimum);
  let result;
  if (options.discover) {
    result = await discoverFromDaemon({ socketPath, clientVersion, minimum });
  } else if (!version.ok) {
    result = closedResult(clientVersion, { reasonCode: version.reasonCode, stage: "version" });
  } else if (!existsSync(socketPath) || !statSync(socketPath).isSocket()) {
    result = closedResult(clientVersion, { reasonCode: "transport_unavailable", stage: "initialize" });
  } else {
    const peer = openWebSocketPeer({ socketPath, timeoutMs: 5_000 });
    try {
      result = await runCodexQueueCapture({ ...input, peer });
    } finally {
      await peer.close();
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function discoverFromDaemon({ socketPath, clientVersion, minimum }) {
  const base = { at: new Date().toISOString(), clientVersion, serverVersion: null, loaded: [],
    reasonCode: null };
  if (!existsSync(socketPath) || !statSync(socketPath).isSocket()) {
    return { ...base, reasonCode: "transport_unavailable" };
  }
  const peer = openWebSocketPeer({ socketPath, timeoutMs: 5_000 });
  try {
    const probe = await probeCodexQueue(peer, { clientVersion, threadId: "thread_discover", minimum });
    base.serverVersion = probe.serverVersion;
    if (!probe.supported) return { ...base, reasonCode: probe.reasonCode };
    return { ...base, loaded: await discoverCodexThreads(peer) };
  } catch (error) {
    return { ...base, reasonCode: safeReason(error) };
  } finally {
    await peer.close();
  }
}

const invokedDirectly = typeof process.argv[1] === "string"
  && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === import.meta.filename;
if (invokedDirectly) await main();
