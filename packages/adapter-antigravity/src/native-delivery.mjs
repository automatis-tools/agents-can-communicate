import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { decisionBody } from "@agents-can-communicate/adapter-sdk";

import { PROTOCOL_CONTRACT, RELAY_MODES, listRegistrations, readRegistration, relayDir }
  from "./relay-endpoint.mjs";

/**
 * The adapter's side of live delivery: find the relay the agent started for a
 * conversation, prove it is serving, and hand it envelopes. It never retires the
 * relay: the relay owns its registration and ends itself with its agy. Every
 * answer is a closed fact; nothing a vendor or a peer wrote leaks through it.
 */
const TRANSPORT = "antigravity-relay";
const defaultAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runDefault = (command, args, { timeout }) => new Promise(resolve => {
  execFile(command, args, { timeout, windowsHide: true },
    (_error, stdout, stderr) => resolve({ stdout: `${stdout ?? ""}${stderr ?? ""}` }));
});
const argvDefault = async pid => (await runDefault("ps", ["-o", "args=", "-p", String(pid)],
  { timeout: 1_000 })).stdout.trim().split(/\s+/).filter(Boolean);

export function isPrintMode(argv) {
  return argv.some(arg => arg === "-p" || arg === "--print" || arg.startsWith("--print=")
    || arg.startsWith("-p="));
}

export async function isSocketSafe(socketPath) {
  try {
    const info = await lstat(socketPath);
    return info.isSocket() && (typeof process.getuid !== "function" || info.uid === process.getuid())
      && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export function askRelay(socketPath, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy();
      reject(Object.assign(new Error("relay timed out"), { code: "ETIMEDOUT" })); }, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
  });
}

const closedHandshake = (clientVersion, reasonCode) => ({ supported: false,
  clientVersion: clientVersion ?? null, protocolContract: PROTOCOL_CONTRACT, modes: [],
  opaqueEndpointRef: null, leaseUntil: null, reasonCode });

async function serving(record, { timeoutMs, isAlive, clientPid }) {
  if (record === null || record.protocolContract !== PROTOCOL_CONTRACT) return "native_session_unavailable";
  if (clientPid !== undefined && record.agyPid !== clientPid) return "native_session_unavailable";
  if (!isAlive(record.agyPid) || !isAlive(record.relayPid)) return "native_session_unavailable";
  if (Date.parse(record.leaseUntil) <= Date.now()) return "native_session_unavailable";
  if (!await isSocketSafe(record.socketPath)) return "native_session_unavailable";
  try {
    const pong = await askRelay(record.socketPath, { nonce: record.nonce, ping: true }, timeoutMs);
    return pong?.accepted === true && pong.ping === true ? null : "handshake_failed";
  } catch (error) {
    return error?.code === "ETIMEDOUT" ? "handshake_timeout" : "handshake_failed";
  }
}

const handshake = record => ({ supported: true, clientVersion: record.clientVersion,
  protocolContract: PROTOCOL_CONTRACT, modes: [...RELAY_MODES],
  opaqueEndpointRef: record.endpointId, leaseUntil: record.leaseUntil, reasonCode: null });

export async function probeNativeDelivery({ timeoutMs = 750, run = runDefault } = {}) {
  const unsupported = (reasonCode, clientVersion = null) => ({ supported: false, clientVersion,
    protocolContract: PROTOCOL_CONTRACT, executableFingerprint: null, modes: [], reasonCode });
  try {
    const version = /(\d+\.\d+\.\d+)/.exec((await run("agy", ["--version"],
      { timeout: timeoutMs })).stdout)?.[1] ?? null;
    if (version === null) return unsupported("feature_probe_failed");
    const help = (await run("agy", ["agentapi", "--help"], { timeout: timeoutMs })).stdout;
    if (!/send-message/.test(help)) return unsupported("protocol_mismatch", version);
    return { supported: true, clientVersion: version, protocolContract: PROTOCOL_CONTRACT,
      executableFingerprint: null, modes: [...RELAY_MODES], reasonCode: null };
  } catch {
    return unsupported("feature_probe_failed");
  }
}

export function planNativeActivation() {
  return { eligible: true, reasonCode: null,
    mechanisms: [{ kind: "native-config", artifactIds: ["antigravity-relay"] }] };
}

export async function bindNativeSession({ event, clientPid, clientVersion, runtimeDir,
  timeoutMs = 750, isAlive = defaultAlive } = {}) {
  if (!Number.isInteger(clientPid) || clientPid <= 0) return closedHandshake(clientVersion, "client_process_unknown");
  const candidates = (await listRegistrations({ runtimeDir }))
    .filter(record => record.conversationId === event?.sessionId);
  for (const record of candidates) {
    if (await serving(record, { timeoutMs, isAlive, clientPid }) === null) return handshake(record);
  }
  return closedHandshake(clientVersion, "native_session_unavailable");
}

export async function refreshNativeSession({ binding, runtimeDir, timeoutMs = 750,
  isAlive = defaultAlive } = {}) {
  const record = await readRegistration({ runtimeDir, endpointId: binding?.opaqueEndpointRef });
  const reasonCode = await serving(record, { timeoutMs, isAlive });
  return reasonCode === null ? handshake(record) : closedHandshake(binding?.clientVersion, reasonCode);
}

const SAFE_CODES = new Map([["recipient_unavailable", "recipient_unavailable"],
  ["transport_rejected", "transport_rejected"], ["bad_nonce", "recipient_unavailable"]]);

export async function offerMessage({ binding, message, runtimeDir, timeoutMs = 8_000 } = {}) {
  const rejected = safeErrorCode => ({ accepted: false, transport: TRANSPORT,
    clientVersion: binding?.clientVersion ?? null, safeErrorCode });
  const record = await readRegistration({ runtimeDir, endpointId: binding?.opaqueEndpointRef });
  if (record === null || Date.parse(record.leaseUntil) <= Date.now()
    || !await isSocketSafe(record.socketPath)) return rejected("recipient_unavailable");
  const envelope = { nonce: record.nonce, messageId: message.messageId, kind: message.kind,
    subject: message.subject ?? "", body: decisionBody(message),
    ...(typeof message.inReplyTo === "string" ? { inReplyTo: message.inReplyTo } : {}),
    ...(typeof message.fromParticipantId === "string"
      ? { fromParticipantId: message.fromParticipantId } : {}) };
  try {
    const answer = await askRelay(record.socketPath, envelope, timeoutMs);
    if (answer?.accepted === true) {
      return { accepted: true, transport: TRANSPORT, clientVersion: record.clientVersion };
    }
    return rejected(SAFE_CODES.get(answer?.reasonCode) ?? "transport_error");
  } catch {
    return rejected("transport_error");
  }
}

const ASK_LIMIT = 3;
const HINT = home => "ACC: live delivery is on but not running in this conversation. To let "
  + `peers reach you while idle, run once: sh "${path.join(home, ".gemini", "config", "acc",
    "acc-relay.sh")}" start`;

// Each ask is its own file, created exclusively. A counter read and then
// rewritten lets overlapping calls all observe the same count and each return
// a hint. An empty file at the unsuffixed hash is the old one-ask marker: it
// is not one of these three, so it does not spend the budget. The path is a
// reservation: the caller deletes it when the line is not delivered.
async function claimAsk(directory, marker) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  for (let n = 1; n <= ASK_LIMIT; n += 1) {
    const slot = `${marker}.${n}`;
    let handle;
    try {
      handle = await open(slot, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | constants.O_NOFOLLOW, 0o600);
      return slot;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return null;
}

function releaseAsk(slot) {
  return rm(slot, { force: true }).catch(() => {});
}

async function relayAlreadyServing({ runtimeDir, conversationId, clientPid, isAlive }) {
  for (const record of await listRegistrations({ runtimeDir })) {
    if (record.conversationId !== conversationId) continue;
    if (await serving(record, { timeoutMs: 100, isAlive, clientPid }) === null) return true;
  }
  return false;
}

export async function nativeActivationHint({ event, nativeBinding, runtimeDir, clientPid, env,
  argvOf = argvDefault, isAlive = defaultAlive }) {
  // Only a degraded binding can be helped by starting a relay: "off" means the
  // live policy is off, "unsupported" that the contract does not admit this
  // client, and "active" that a relay already serves it. Those calls spend
  // none of the asks recorded below.
  if (nativeBinding?.state !== "degraded") return null;
  const home = env?.HOME;
  if (typeof event?.sessionId !== "string" || typeof home !== "string" || home === "") return null;
  if (!Number.isInteger(clientPid) || isPrintMode(await argvOf(clientPid).catch(() => []))) return null;
  // The runner asks only when its own handshake failed. A relay can still be
  // serving under a stale degraded binding; telling the agent to start it again
  // would be wrong, and the check does not spend an ask.
  if (await relayAlreadyServing({ runtimeDir, conversationId: event.sessionId, clientPid,
    isAlive })) return null;
  const asked = path.join(path.dirname(relayDir(runtimeDir)), "antigravity-asked");
  const marker = path.join(asked, createHash("sha256").update(event.sessionId).digest("hex"));
  // A decline and an ignored ask leave the same trace, so neither can stop the
  // line by itself. Three exclusive creates are the bound. The file reserves
  // the number now; release gives it back when the runner does not deliver.
  const slot = await claimAsk(asked, marker);
  if (slot === null) return null;
  return { line: HINT(home), release: () => releaseAsk(slot) };
}
