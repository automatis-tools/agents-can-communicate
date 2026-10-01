import net from "node:net";
import { compareVersionOrder, isWindowsPlatform, versionOrder } from "@agents-can-communicate/adapter-sdk";

import { INBOX_MODES, MIN_VERSION, PROTOCOL_CONTRACT, TRANSPORT } from "./inbox-contract.mjs";
import { claimWake, newEndpointId, readInboxEndpoint, releaseWake, removeInboxEndpoint,
  sweepDeadEndpoints, writeInboxEndpoint } from "./inbox-endpoint.mjs";
import { claudeConfigDir, listPipesOfMachine, readPeerKey, readSessionRecord, verifyInbox }
  from "./inbox-registry.mjs";
import { MANAGED_SETTINGS, permissionModeFromArgs, readInboundSettings, readProcessArgs, receptionOf }
  from "./inbox-settings.mjs";

// Live delivery into a Claude Code session through the inbox socket the
// session itself binds (2.1.224 and later, no flag, every provider).
//
// The offer is a wake, never the message. Measured on 2.1.282: every frame a
// session accepts on its inbox fires UserPromptSubmit, idle or between two tool
// calls, and ACC's beforeTurn hook then projects the queued message inside its
// untrusted block, with receipts and the `acc reply` route. So the frame
// carries fixed ACC wording and the ACC message id, and no byte a peer wrote:
// Claude Code frames every inbox message as a teammate's request to act on,
// and the only thing a wake gives it to act on is ACC's own notice.
//
// On POSIX the connection sends no auth line: the socket is this user's alone.
// Windows refuses a frame without one (measured on 2.1.286), so there the
// offer authenticates with the peer key Claude publishes for other sessions of
// the same user, and the wake is classified a peer's. This module never reads
// the session's own messaging token: a frame carrying it would pass as the
// session's child and skip the inbound controls its user set.

const LEASE_MS = 120_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const PROBE_NEEDLE = Buffer.from("messagingSocketPath");
const PROBE_MAX_BYTES = 256 * 1024 * 1024;

export { INBOX_MODES, MIN_VERSION, PROTOCOL_CONTRACT, TRANSPORT };

// Claude Code shows the wake as a message from another Claude session, so the
// text names the ACC route: a model otherwise tries SendMessage first.
export const wakeText = messageId => `ACC: new peer message ${messageId} for this session. `
  + "This turn's ACC context shows it. If it does not, it was already shown, or read it with "
  + `acc inbox --message ${messageId}. Answer it through ACC with acc reply --message ${messageId}; `
  + "SendMessage cannot deliver to an ACC participant.";

// A version is judged by its release triple: a prerelease of a version above
// the minimum is not an older client, and the inbox in the executable is what
// admits it. An unreadable version orders as null.
const belowMinimum = clientVersion => compareVersionOrder(versionOrder(clientVersion),
  versionOrder(MIN_VERSION)) < 0;

// The registry field only a build with the inbox writes. Read-only, bounded.
async function executableHasInbox(realExecutable) {
  let handle;
  try {
    handle = await (await import("node:fs/promises")).open(realExecutable, "r");
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return false;
      const window = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (window.includes(PROBE_NEEDLE)) return true;
      carry = window.subarray(Math.max(0, window.length - PROBE_NEEDLE.length));
      position += bytesRead;
      if (position >= PROBE_MAX_BYTES) return false;
    }
  } finally {
    await handle.close().catch(() => null);
  }
}

function defaultReadVersion(realExecutable, timeoutMs) {
  return new Promise(resolve => {
    import("node:child_process").then(({ execFile }) => {
      execFile(realExecutable, ["--version"], { timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          if (error !== null) return resolve(null);
          resolve(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(`${stdout}${stderr}`)?.[1] ?? null);
        });
    });
  });
}

function withTimeout(work, ms) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("native probe timed out"),
      { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Read-only: a version at or above the capture, a platform whose inbox is a
 * Unix socket, and an executable that writes the inbox into its session
 * registry. Never launches a session. Native Windows serves a named pipe that
 * demands an auth line; nothing there is captured, so it keeps hook delivery.
 */
export async function probeNativeDelivery({ realExecutable, timeoutMs = 750, platform = process.platform,
  hasInbox = executableHasInbox, readVersion = defaultReadVersion } = {}) {
  const unsupported = (reasonCode, clientVersion = null) => ({ supported: false, clientVersion,
    protocolContract: PROTOCOL_CONTRACT, executableFingerprint: null, modes: [], reasonCode });
  if (platform === "win32") return unsupported("native_delivery_unsupported");
  if (typeof realExecutable !== "string" || realExecutable === "") return unsupported("feature_probe_failed");
  const clientVersion = await withTimeout(Promise.resolve(readVersion(realExecutable, timeoutMs)), timeoutMs)
    .catch(() => null);
  if (versionOrder(clientVersion) === null) return unsupported("feature_probe_failed", clientVersion);
  if (belowMinimum(clientVersion)) return unsupported("below_minimum_version", clientVersion);
  const present = await withTimeout(Promise.resolve(hasInbox(realExecutable)), timeoutMs).catch(() => false);
  if (!present) return unsupported("protocol_mismatch", clientVersion);
  return { supported: true, clientVersion, protocolContract: PROTOCOL_CONTRACT,
    executableFingerprint: null, modes: [...INBOX_MODES], reasonCode: null };
}

// Claude Code runs the inbox itself. ACC starts nothing and rewrites no argument.
export function planNativeActivation({ detection }) {
  if (typeof detection?.realExecutable !== "string" || detection.realExecutable === "") {
    return { eligible: false, reasonCode: "feature_probe_failed", mechanisms: [] };
  }
  return { eligible: true, reasonCode: null, mechanisms: [{ kind: "native-service",
    serviceId: "claude-code-inbox", preExisting: true, applyCommand: null, teardownCommand: null }] };
}

const closed = (clientVersion, reasonCode) => ({ supported: false, clientVersion: clientVersion ?? null,
  protocolContract: PROTOCOL_CONTRACT, modes: [], opaqueEndpointRef: null, leaseUntil: null, reasonCode });
const handshake = (endpoint, now) => ({ supported: true, clientVersion: endpoint.clientVersion,
  protocolContract: PROTOCOL_CONTRACT, modes: [...INBOX_MODES], opaqueEndpointRef: endpoint.endpointId,
  leaseUntil: new Date(now() + LEASE_MS).toISOString(), reasonCode: null });

/**
 * Bind this ACC session to the inbox of the Claude process whose hook is
 * running. The socket comes from the hook's own environment, which Claude Code
 * exports per session and never inherits from a parent; the registry must
 * name this process and this socket before anything is published. The session
 * id is checked by every offer and refresh, since after /resume the registry
 * catches up only once the hook has run.
 */
export async function bindNativeSession({ event, clientPid, clientVersion, runtimeDir,
  env = process.env, now = Date.now, managedSettingsPath = MANAGED_SETTINGS[process.platform],
  readClientArgs = readProcessArgs, platform = process.platform, listPipes = listPipesOfMachine } = {}) {
  if (!Number.isInteger(clientPid) || clientPid <= 0) return closed(clientVersion, "client_process_unknown");
  if (typeof event?.sessionId !== "string" || event.sessionId === "") {
    return closed(clientVersion, "handshake_failed");
  }
  if (versionOrder(clientVersion) === null) return closed(clientVersion, "version_unavailable");
  // The contract refuses it anyway, after this returns. Refusing here keeps an
  // older client - which binds again on every turn - from writing an endpoint
  // record each time.
  if (belowMinimum(clientVersion)) return closed(clientVersion, "below_minimum_version");
  const socketPath = env?.CLAUDE_CODE_MESSAGING_SOCKET;
  if (typeof socketPath !== "string" || socketPath === "") {
    return closed(clientVersion, "native_endpoint_unavailable");
  }
  await sweepDeadEndpoints({ runtimeDir, platform });
  const configDir = claudeConfigDir(env);
  const refused = await verifyInbox({ configDir, clientPid, sessionId: event.sessionId, socketPath,
    anyConversation: true, platform, listPipes });
  if (refused !== null) return closed(clientVersion, refused);
  // Project settings sit where the session was started, which the registry
  // records; the hook's cwd follows the shell.
  const record = await readSessionRecord({ configDir, clientPid, platform });
  const settings = await readInboundSettings({ configDir, projectDir: record?.cwd ?? event.cwd,
    managedSettingsPath });
  // The hook's mode is current. SessionStart carries none, so until the first
  // prompt the launch flag stands in, then the configured default.
  const launchMode = event.permissionMode == null
    ? permissionModeFromArgs(await readClientArgs(clientPid).catch(() => null)) : null;
  const reception = receptionOf({
    permissionMode: event.permissionMode ?? launchMode ?? settings.defaultMode,
    crossSessionInbound: settings.crossSessionInbound });
  const endpoint = { schemaVersion: 1, endpointId: newEndpointId(), socketPath, configDir, clientPid,
    sessionId: event.sessionId, clientVersion, protocolContract: PROTOCOL_CONTRACT,
    leaseUntil: new Date(now() + LEASE_MS).toISOString(), reception };
  try {
    await writeInboxEndpoint({ runtimeDir, record: endpoint, platform, listPipes });
  } catch {
    return closed(clientVersion, "handshake_failed");
  }
  return handshake(endpoint, now);
}

async function verifiedEndpoint(binding, runtimeDir, system) {
  const endpoint = await readInboxEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef,
    platform: system.platform });
  if (endpoint === null) return null;
  const refused = await verifyInbox({ configDir: endpoint.configDir, clientPid: endpoint.clientPid,
    sessionId: endpoint.sessionId, socketPath: endpoint.socketPath, ...system });
  return refused === null ? endpoint : null;
}

// The router calls this when a lease ran out, so a session that sits idle
// between turns stays reachable. The id never changes on a refresh.
export async function refreshNativeSession({ binding, runtimeDir, now = Date.now,
  platform = process.platform, listPipes = listPipesOfMachine } = {}) {
  const endpoint = await verifiedEndpoint(binding, runtimeDir, { platform, listPipes });
  return endpoint === null ? closed(binding?.clientVersion, "handshake_failed") : handshake(endpoint, now);
}

export const retireNativeSession = ({ binding, runtimeDir, platform = process.platform }) =>
  removeInboxEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef, platform });

/**
 * Sender side: re-verify the receiver, then write one wake line. The socket
 * answers nothing, so acceptance is a line written to a verified inbox without
 * an error inside the timeout. What the model then sees is recorded by the
 * receiver's own hook.
 */
export async function offerMessage({ binding, message, runtimeDir, timeoutMs = 2_000,
  connect = net.createConnection, platform = process.platform, listPipes = listPipesOfMachine } = {}) {
  const rejected = safeErrorCode => ({ accepted: false, transport: TRANSPORT,
    clientVersion: binding?.clientVersion ?? null, safeErrorCode });
  if (typeof message?.messageId !== "string" || !MESSAGE_ID.test(message.messageId)) {
    return rejected("transport_rejected");
  }
  const endpoint = await verifiedEndpoint(binding, runtimeDir, { platform, listPipes });
  if (endpoint === null) return rejected("recipient_unavailable");
  // Read per offer and kept nowhere: the key of the process the record names now.
  const peerToken = isWindowsPlatform(platform) ? await readPeerKey({ configDir: endpoint.configDir,
    record: await readSessionRecord({ configDir: endpoint.configDir, clientPid: endpoint.clientPid, platform }) })
    : null;
  if (isWindowsPlatform(platform) && peerToken === null) return rejected("recipient_unavailable");
  // The receiver's own crossSessionInbound refuses unattested wakes; one would
  // be dropped, so none is sent and the message waits for its next turn.
  if (endpoint.reception === "refused") return rejected("delivery_disabled");
  const accepted = { accepted: true, transport: TRANSPORT, clientVersion: endpoint.clientVersion,
    ...(endpoint.reception === "held" ? { pendingApproval: true } : {}) };
  const wake = { runtimeDir, endpointId: endpoint.endpointId, messageId: message.messageId, platform };
  // Claude Code delivers a repeated msg_id again, so the dedupe is ours.
  let first;
  try {
    first = await claimWake(wake);
  } catch {
    return rejected("transport_error");
  }
  if (!first) return accepted;
  const auth = peerToken === null ? "" : `${JSON.stringify({ type: "auth", token: peerToken })}\n`;
  const frame = `${auth}${JSON.stringify({ type: "user",
    message: { role: "user", content: wakeText(message.messageId) },
    msg_id: `acc-wake-${message.messageId}` })}\n`;
  const result = await new Promise(resolve => {
    const socket = connect(endpoint.socketPath);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(rejected("transport_error")), timeoutMs);
    socket.once("error", error => finish(rejected(["EPERM", "EACCES"].includes(error?.code)
      ? "transport_permission_denied" : "recipient_unavailable")));
    socket.once("connect", () => socket.end(frame, () => finish(accepted)));
  });
  if (!result.accepted) await releaseWake(wake);
  return result;
}
