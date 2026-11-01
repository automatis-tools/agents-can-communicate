import os from "node:os";
import { compareVersionOrder, runExecutable, versionOrder } from "@agents-can-communicate/adapter-sdk";

import { MIN_VERSION, PROTOCOL_CONTRACT, TRANSPORT, WEB_MODES } from "./web-contract.mjs";
import { getMeta, getSessionFacts, getSessionStatus, submitPrompt } from "./web-client.mjs";
import { canonicalCwd, kimiHomeDir, readServerToken, verifyWebSession } from "./web-registry.mjs";
import { claimWake, newEndpointId, readWakeOutcome, readWebEndpoint, recordWake, releaseWake, removeWebEndpoint,
  sweepDeadEndpoints, writeWebEndpoint } from "./web-endpoint.mjs";

const LEASE_MS = 120_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const belowMinimum = version => compareVersionOrder(versionOrder(version), versionOrder(MIN_VERSION)) < 0;
const closed = (clientVersion, reasonCode) => ({ supported: false, clientVersion: clientVersion ?? null,
  protocolContract: PROTOCOL_CONTRACT, modes: [], opaqueEndpointRef: null, leaseUntil: null, reasonCode });
const handshake = endpoint => ({ supported: true, clientVersion: endpoint.clientVersion,
  protocolContract: PROTOCOL_CONTRACT, modes: [...WEB_MODES], opaqueEndpointRef: endpoint.endpointId,
  leaseUntil: endpoint.leaseUntil, reasonCode: null });

export const wakeText = messageId => `ACC: new peer message ${messageId} for this session. `
  + "This turn's ACC context shows it. If it does not, read it with "
  + `acc inbox --message ${messageId}. Answer through ACC with acc reply --message ${messageId}.`;

export async function probeNativeDelivery({ realExecutable, timeoutMs = 750 } = {}) {
  const unsupported = (reasonCode, clientVersion = null) => ({ supported: false, clientVersion,
    protocolContract: PROTOCOL_CONTRACT, executableFingerprint: null, modes: [], reasonCode });
  if (typeof realExecutable !== "string" || realExecutable === "") return unsupported("feature_probe_failed");
  const output = await runExecutable(realExecutable, ["--version"], { timeout: timeoutMs })
    .then(({ stdout, stderr }) => `${stdout}${stderr}`, () => "");
  const clientVersion = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1] ?? null;
  if (versionOrder(clientVersion) === null) return unsupported("feature_probe_failed");
  if (belowMinimum(clientVersion)) return unsupported("below_minimum_version", clientVersion);
  return { supported: true, clientVersion, protocolContract: PROTOCOL_CONTRACT,
    executableFingerprint: null, modes: [...WEB_MODES], reasonCode: null };
}

export function planNativeActivation({ detection }) {
  if (typeof detection?.realExecutable !== "string" || detection.realExecutable === "") {
    return { eligible: false, reasonCode: "feature_probe_failed", mechanisms: [] };
  }
  return { eligible: true, reasonCode: null, mechanisms: [{ kind: "native-service",
    serviceId: "kimi-web", preExisting: true, applyCommand: null, teardownCommand: null }] };
}

async function metaFor(endpoint, request, timeoutMs) {
  const token = await readServerToken({ homeDir: endpoint.kimiHome });
  if (token === null) return { ok: false, reason: "unauthorized" };
  return getMeta({ host: endpoint.host, port: endpoint.port, token, request, timeoutMs });
}

async function verifyEndpoint(endpoint, { request, timeoutMs, now, allowUnlocked = true,
  verifyPermission = true, allowUninitialized = false, ...options } = {}) {
  const found = await verifyWebSession({ homeDir: endpoint.kimiHome, clientPid: endpoint.serverPid,
    sessionId: endpoint.sessionId, hostname: endpoint.hostname, now, allowUnlocked, ...options });
  if (found.reason !== null || found.instance.serverId !== endpoint.serverId
    || found.instance.startedAt !== endpoint.startedAt || found.instance.host !== endpoint.host
    || found.instance.port !== endpoint.port) return { endpoint: null, reason: "native_session_unavailable" };
  const factsToken = await readServerToken({ homeDir: endpoint.kimiHome });
  if (factsToken === null) return { endpoint: null, reason: "unauthorized" };
  const session = await getSessionFacts({ host: endpoint.host, port: endpoint.port,
    token: factsToken, sessionId: endpoint.sessionId, request, timeoutMs });
  if (!session.ok) return { endpoint: null, reason: session.reason };
  const sessionCwd = await canonicalCwd(session.facts.cwd);
  // /sessions/:id reads metadata without resuming. After initialization an
  // empty model means the reaper closed the live program; no wake may follow.
  if ((session.facts.model === "" && !allowUninitialized) || session.facts.archived
    || sessionCwd === null || sessionCwd !== endpoint.cwd) {
    return { endpoint: null, reason: "native_session_unavailable" };
  }
  const result = await metaFor(endpoint, request, timeoutMs);
  if (!result.ok) return { endpoint: null, reason: result.reason };
  // Registry and /meta ids are independent in 2.4.0. Pin each pair once, then
  // require both generations to stay unchanged; never equate the two ids.
  if ((endpoint.metaServerId !== "" && (result.meta.serverId !== endpoint.metaServerId
      || result.meta.startedAtMs !== endpoint.metaStartedAt))
    || result.meta.dangerousBypassAuth || belowMinimum(result.meta.serverVersion)) {
    return { endpoint: null, reason: "protocol_mismatch" };
  }
  const verified = { endpoint, serverVersion: result.meta.serverVersion, meta: result.meta, reason: null };
  // Only an actual hook binding may call /status: that route resumes a cold
  // session. Offers revalidate the non-resuming /meta generation instead.
  if (!verifyPermission) return verified;
  const token = await readServerToken({ homeDir: endpoint.kimiHome });
  if (token === null) return { endpoint: null, reason: "unauthorized" };
  const status = await getSessionStatus({ host: endpoint.host, port: endpoint.port, token,
    sessionId: endpoint.sessionId, request, timeoutMs });
  // The operator explicitly allows yolo for this Web transport. ACC never sets
  // the mode, so manual or unexpected auto sessions fail closed.
  if (!status.ok || status.permission !== "yolo") {
    return { endpoint: null, reason: "native_session_unavailable" };
  }
  return { endpoint, serverVersion: result.meta.serverVersion, meta: result.meta, reason: null };
}

export async function bindNativeSession({ event, clientPid, clientVersion, runtimeDir,
  env = process.env, now = Date.now, request, timeoutMs = 2_000, ...options } = {}) {
  if (!Number.isInteger(clientPid) || clientPid <= 0) return closed(clientVersion, "client_process_unknown");
  if (typeof event?.sessionId !== "string" || versionOrder(clientVersion) === null) {
    return closed(clientVersion, "handshake_failed");
  }
  if (belowMinimum(clientVersion)) return closed(clientVersion, "below_minimum_version");
  const cwd = await canonicalCwd(event.cwd);
  if (cwd === null) return closed(clientVersion, "handshake_failed");
  await sweepDeadEndpoints({ runtimeDir });
  const endpoint = { schemaVersion: 1, endpointId: newEndpointId(), kimiHome: kimiHomeDir(env),
    serverId: "", serverPid: clientPid, host: "", port: 0, startedAt: 0, metaServerId: "",
    metaStartedAt: 0, clientVersion, sessionId: event.sessionId, cwd, hostname: options.hostname,
    protocolContract: PROTOCOL_CONTRACT, leaseUntil: new Date(now() + LEASE_MS).toISOString() };
  const allowUnlocked = event?.kind !== "sessionStart";
  const found = await verifyWebSession({ homeDir: endpoint.kimiHome, clientPid,
    sessionId: event.sessionId, now, allowUnlocked, ...options });
  if (found.reason !== null) return closed(clientVersion, found.reason);
  Object.assign(endpoint, { serverId: found.instance.serverId, host: found.instance.host,
    port: found.instance.port, startedAt: found.instance.startedAt,
    hostname: found.lock?.hostname ?? options.hostname ?? os.hostname() });
  const verified = await verifyEndpoint(endpoint, { request, timeoutMs, now, allowUnlocked,
    allowUninitialized: event.kind === "sessionStart", ...options });
  if (verified.endpoint === null || verified.serverVersion !== clientVersion
    || verified.meta.startedAtMs < endpoint.startedAt || verified.meta.startedAtMs > now() + 5_000) {
    const reason = verified.reason;
    return closed(clientVersion, reason === null ? "protocol_mismatch"
      : ["native_endpoint_unavailable", "native_session_unavailable", "protocol_mismatch"].includes(reason)
        ? reason : "handshake_failed");
  }
  Object.assign(endpoint, { metaServerId: verified.meta.serverId,
    metaStartedAt: verified.meta.startedAtMs });
  try {
    await writeWebEndpoint({ runtimeDir, record: endpoint });
  } catch {
    return closed(clientVersion, "handshake_failed");
  }
  return handshake(endpoint, now);
}

async function currentEndpoint(binding, runtimeDir, options) {
  const endpoint = await readWebEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef });
  if (endpoint === null) return { endpoint: null, reason: "native_endpoint_unavailable" };
  return verifyEndpoint(endpoint, options);
}

export async function refreshNativeSession({ binding, runtimeDir, now = Date.now, ...options } = {}) {
  const verified = await currentEndpoint(binding, runtimeDir, { ...options, now });
  if (verified.endpoint === null) return closed(binding?.clientVersion, "handshake_failed");
  const endpoint = { ...verified.endpoint, leaseUntil: new Date(now() + LEASE_MS).toISOString() };
  try {
    await writeWebEndpoint({ runtimeDir, record: endpoint });
  } catch {
    return closed(binding?.clientVersion, "handshake_failed");
  }
  return handshake(endpoint, now);
}

export const retireNativeSession = ({ binding, runtimeDir }) =>
  removeWebEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef });

const rejected = (binding, safeErrorCode) => ({ accepted: false, transport: TRANSPORT,
  clientVersion: binding?.clientVersion ?? null, safeErrorCode });
const errorCode = reason => reason === "permission" ? "transport_permission_denied"
  : ["unavailable", "unauthorized", "session_not_found", "session_unavailable",
    "native_endpoint_unavailable", "native_session_unavailable"].includes(reason)
    ? "recipient_unavailable" : "transport_error";

export async function offerMessage({ binding, message, runtimeDir, now = Date.now,
  timeoutMs = 2_000, ...options } = {}) {
  if (typeof message?.messageId !== "string" || !MESSAGE_ID.test(message.messageId)) {
    return rejected(binding, "transport_rejected");
  }
  const recorded = await readWebEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef });
  if (recorded === null) return rejected(binding, "recipient_unavailable");
  // The lease gate precedes every HTTP request. An expired or superseded
  // binding gets no opportunity to reach a resume-capable route. /status is
  // read only later, after the warm check below.
  if (Date.parse(binding?.leaseUntil) !== Date.parse(recorded.leaseUntil)
    || Date.parse(recorded.leaseUntil) <= now()) return rejected(binding, "recipient_unavailable");
  const verified = await verifyEndpoint(recorded, { ...options, now, timeoutMs,
    verifyPermission: false });
  if (verified.endpoint === null) return rejected(binding, errorCode(verified.reason));
  const endpoint = verified.endpoint;
  const accepted = extra => ({ accepted: true, transport: TRANSPORT,
    clientVersion: verified.serverVersion, ...extra });
  const wake = { runtimeDir, endpointId: endpoint.endpointId, messageId: message.messageId };
  let first;
  try {
    first = await claimWake(wake);
  } catch {
    return rejected(binding, "transport_error");
  }
  if (!first) {
    // A duplicate repeats the first submit's recorded outcome. With none yet,
    // the first offer is still deciding - it may still refuse and release the
    // marker - so nothing has been accepted to repeat: the message stays queued
    // for its next offer or turn. A first offer that died here leaves the same
    // answer, which only costs a wake the next turn still delivers.
    const outcome = await readWakeOutcome(wake);
    if (outcome === null) return rejected(binding, "recipient_busy");
    return accepted(outcome === "running" ? {} : { queueStatus: "queued" });
  }
  const token = await readServerToken({ homeDir: endpoint.kimiHome });
  if (token === null) {
    await releaseWake(wake);
    return rejected(binding, "recipient_unavailable");
  }
  // A reaper can still win the small race after this lock/lease check; 2.4.0
  // has no conditional submit. Issue #390 accepts and documents that window.
  const warm = await verifyWebSession({ homeDir: endpoint.kimiHome, clientPid: endpoint.serverPid,
    sessionId: endpoint.sessionId, hostname: endpoint.hostname, now, allowUnlocked: true, ...options });
  if (warm.reason !== null || warm.instance.serverId !== endpoint.serverId
    || warm.instance.startedAt !== endpoint.startedAt) {
    await releaseWake(wake);
    return rejected(binding, "recipient_unavailable");
  }
  // The warm check proves the lock holds the session, so /status cannot wake a
  // cold one. A session that bound in yolo may have switched since: a wake
  // submitted into manual or auto mode would stall on an approval prompt.
  const status = await getSessionStatus({ host: endpoint.host, port: endpoint.port, token,
    sessionId: endpoint.sessionId, request: options.request, timeoutMs });
  if (!status.ok || status.permission !== "yolo") {
    await releaseWake(wake);
    return rejected(binding, "recipient_unavailable");
  }
  const submitted = await submitPrompt({ host: endpoint.host, port: endpoint.port, token,
    sessionId: endpoint.sessionId, promptId: message.messageId, text: wakeText(message.messageId),
    timeoutMs, request: options.request });
  if (submitted.ok) {
    const queued = ["queued", "blocked"].includes(submitted.item.status);
    await recordWake({ ...wake, outcome: queued ? "queued" : "running" });
    return accepted(queued ? { queueStatus: "queued" } : {});
  }
  if (["prompt_id_conflict", "prompt_id_completed"].includes(submitted.reason)) {
    await recordWake({ ...wake, outcome: "queued" });
    return accepted({ queueStatus: "queued" });
  }
  // Only a definite rejection releases the marker. After a timeout/reset the
  // prompt may exist, so a blind retry could spend another turn.
  // An ambiguous one is recorded as queued, the most it can claim: a later
  // duplicate reports that rather than submitting again.
  if (submitted.definite) await releaseWake(wake);
  else await recordWake({ ...wake, outcome: "queued" });
  return rejected(binding, errorCode(submitted.reason));
}
