import { decisionBody } from "@agents-can-communicate/adapter-sdk";

import { createAgentApi } from "./agentapi.mjs";
import { DESKTOP_MODES, DESKTOP_PROTOCOL, httpPort, listDesktopEndpoints, newDesktopEndpointId,
  readDesktopEndpoint, readDesktopServer, removeDesktopEndpoint, writeDesktopEndpoint }
  from "./desktop-endpoint.mjs";
import { renderMessage } from "./relay.mjs";

/**
 * Live delivery into an Antigravity 2.0 desktop conversation.
 *
 * No relay and nothing for the agent to run: the desktop's language server is
 * the client process ACC's own hook ran under, and its command line carries the
 * endpoint. Each bind finds the port that serves `agentapi` and proves it
 * answers for this conversation; each offer reads the token again from the
 * same, still-running server and hands it to one `agentapi` child in that
 * child's environment, exactly as the relay does for Antigravity CLI.
 */
export const DESKTOP_TRANSPORT = "antigravity-desktop";
const LEASE_MS = 120_000;
const CODES = new Map([["recipient_unavailable", "recipient_unavailable"],
  ["transport_rejected", "transport_rejected"]]);

const closed = (clientVersion, reasonCode) => ({ supported: false, clientVersion: clientVersion ?? null,
  protocolContract: DESKTOP_PROTOCOL, modes: [], opaqueEndpointRef: null, leaseUntil: null, reasonCode });
const handshake = record => ({ supported: true, clientVersion: record.clientVersion,
  protocolContract: DESKTOP_PROTOCOL, modes: [...DESKTOP_MODES], opaqueEndpointRef: record.endpointId,
  leaseUntil: record.leaseUntil, reasonCode: null });

const apiFor = ({ server, port, conversationId, runAgentApi, timeoutMs }) => createAgentApi({
  endpoint: { lsAddress: `127.0.0.1:${port}`, csrfToken: server.token, conversationId },
  command: server.executable, timeoutMs, ...(runAgentApi ? { run: runAgentApi } : {}) });

// The server the record names, if it is the same process still: same pid,
// same start time, still the desktop language server.
async function sameServer(record, readServer) {
  const server = await readServer(record.serverPid);
  return server !== null && server.startedAt === record.serverStartedAt ? server : null;
}

/**
 * The desktop bind, or null when the client process is not the desktop's
 * language server - the caller then binds Antigravity CLI's relay instead.
 */
export async function bindDesktop({ event, clientPid, clientVersion, runtimeDir, timeoutMs = 750,
  now = Date.now, readServer = readDesktopServer, findPort = httpPort, runAgentApi } = {}) {
  const server = await readServer(clientPid);
  if (server === null) return null;
  const version = server.version ?? clientVersion;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    return closed(clientVersion, "version_unavailable");
  }
  const conversationId = event?.sessionId;
  if (typeof conversationId !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(conversationId)) {
    return closed(version, "handshake_failed");
  }
  const port = await findPort(clientPid);
  if (port === null) return closed(version, "native_endpoint_unavailable");
  const answer = await apiFor({ server, port, conversationId, runAgentApi, timeoutMs })
    .conversationMetadata();
  if (!answer.ok) {
    return closed(version, answer.reasonCode === "recipient_unavailable"
      ? "native_session_unavailable" : "handshake_failed");
  }
  // One record per conversation: the one this bind proved.
  for (const old of await listDesktopEndpoints({ runtimeDir })) {
    if (old.conversationId === conversationId) await removeDesktopEndpoint({ runtimeDir, endpointId: old.endpointId });
  }
  const record = { schemaVersion: 1, endpointId: newDesktopEndpointId(), conversationId,
    serverPid: clientPid, serverStartedAt: server.startedAt, port, clientVersion: version,
    protocolContract: DESKTOP_PROTOCOL, modes: [...DESKTOP_MODES],
    leaseUntil: new Date(now() + LEASE_MS).toISOString() };
  await writeDesktopEndpoint({ runtimeDir, record });
  return handshake(record);
}

/** The router's re-check before an offer on an expired lease. */
export async function refreshDesktop({ binding, runtimeDir, timeoutMs = 750, now = Date.now,
  readServer = readDesktopServer, runAgentApi } = {}) {
  const record = await readDesktopEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef });
  if (record === null) return closed(binding?.clientVersion, "native_session_unavailable");
  const server = await sameServer(record, readServer);
  if (server === null) return closed(record.clientVersion, "native_session_unavailable");
  const answer = await apiFor({ server, port: record.port, conversationId: record.conversationId,
    runAgentApi, timeoutMs }).conversationMetadata();
  if (!answer.ok) return closed(record.clientVersion, "handshake_failed");
  const renewed = { ...record, leaseUntil: new Date(now() + LEASE_MS).toISOString() };
  await writeDesktopEndpoint({ runtimeDir, record: renewed });
  return handshake(renewed);
}

/** One fenced ACC message into the conversation, rendered here, never by the sender. */
export async function offerDesktop({ binding, message, runtimeDir, timeoutMs = 8_000, now = Date.now,
  readServer = readDesktopServer, runAgentApi, budgetBytes = 6_000 } = {}) {
  const rejected = safeErrorCode => ({ accepted: false, transport: DESKTOP_TRANSPORT,
    clientVersion: binding?.clientVersion ?? null, safeErrorCode });
  const record = await readDesktopEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef });
  if (record === null || Date.parse(record.leaseUntil) <= now()) return rejected("recipient_unavailable");
  const server = await sameServer(record, readServer);
  if (server === null) return rejected("recipient_unavailable");
  const text = renderMessage({ messageId: message.messageId, kind: message.kind,
    subject: message.subject ?? "", body: decisionBody(message),
    ...(typeof message.inReplyTo === "string" ? { inReplyTo: message.inReplyTo } : {}),
    ...(typeof message.fromParticipantId === "string" ? { fromParticipantId: message.fromParticipantId } : {}) },
  { budgetBytes });
  const answer = await apiFor({ server, port: record.port, conversationId: record.conversationId,
    runAgentApi, timeoutMs }).sendMessage(text);
  return answer.ok ? { accepted: true, transport: DESKTOP_TRANSPORT, clientVersion: record.clientVersion }
    : rejected(CODES.get(answer.reasonCode) ?? "transport_error");
}
