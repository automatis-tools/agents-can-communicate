import net from "node:net";

import { INBOX_MODES, MIN_VERSION, PROTOCOL_CONTRACT, TRANSPORT } from "./inbox-contract.mjs";
import { newEndpointId, readInboxEndpoint, removeInboxEndpoint, writeInboxEndpoint }
  from "./inbox-endpoint.mjs";
import { claudeConfigDir, verifyInbox } from "./inbox-registry.mjs";

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
// The connection sends no auth line, and this module never reads the
// session's messaging token or key file. A frame carrying that token would
// pass as the session's own child and skip the inbound controls its user set.

const LEASE_MS = 120_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const PROBE_NEEDLE = Buffer.from("messagingSocketPath");
const PROBE_MAX_BYTES = 256 * 1024 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;

export { INBOX_MODES, MIN_VERSION, PROTOCOL_CONTRACT, TRANSPORT };

export const wakeText = messageId => `ACC: new peer message ${messageId} for this session. `
  + "This turn's ACC context shows it. If it does not, it was already shown, or read it with "
  + `acc inbox --message ${messageId}.`;

function compare(left, right) {
  const a = left.split("+")[0].split(".").map(Number);
  const b = right.split("+")[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

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
 * Read-only: a stable version at or above the capture, a platform whose inbox
 * is a Unix socket, and an executable that writes the inbox into its session
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
  if (clientVersion === null || !STABLE_VERSION.test(clientVersion)) {
    return unsupported("feature_probe_failed", clientVersion);
  }
  if (compare(clientVersion, MIN_VERSION) < 0) return unsupported("below_minimum_version", clientVersion);
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
 * agree on both the session id and the socket before anything is published.
 */
export async function bindNativeSession({ event, clientPid, clientVersion, runtimeDir,
  env = process.env, now = Date.now } = {}) {
  if (!Number.isInteger(clientPid) || clientPid <= 0) return closed(clientVersion, "client_process_unknown");
  if (typeof event?.sessionId !== "string" || event.sessionId === "") {
    return closed(clientVersion, "handshake_failed");
  }
  if (typeof clientVersion !== "string" || !STABLE_VERSION.test(clientVersion)) {
    return closed(clientVersion, "version_unavailable");
  }
  const socketPath = env?.CLAUDE_CODE_MESSAGING_SOCKET;
  if (typeof socketPath !== "string" || socketPath === "") {
    return closed(clientVersion, "native_endpoint_unavailable");
  }
  const configDir = claudeConfigDir(env);
  const refused = await verifyInbox({ configDir, clientPid, sessionId: event.sessionId, socketPath });
  if (refused !== null) return closed(clientVersion, refused);
  const endpoint = { schemaVersion: 1, endpointId: newEndpointId(), socketPath, configDir, clientPid,
    sessionId: event.sessionId, clientVersion, protocolContract: PROTOCOL_CONTRACT,
    leaseUntil: new Date(now() + LEASE_MS).toISOString() };
  try {
    await writeInboxEndpoint({ runtimeDir, record: endpoint });
  } catch {
    return closed(clientVersion, "handshake_failed");
  }
  return handshake(endpoint, now);
}

async function verifiedEndpoint(binding, runtimeDir) {
  const endpoint = await readInboxEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef });
  if (endpoint === null) return null;
  const refused = await verifyInbox({ configDir: endpoint.configDir, clientPid: endpoint.clientPid,
    sessionId: endpoint.sessionId, socketPath: endpoint.socketPath });
  return refused === null ? endpoint : null;
}

// The router calls this when a lease ran out, so a session that sits idle
// between turns stays reachable. The id never changes on a refresh.
export async function refreshNativeSession({ binding, runtimeDir, now = Date.now } = {}) {
  const endpoint = await verifiedEndpoint(binding, runtimeDir);
  return endpoint === null ? closed(binding?.clientVersion, "handshake_failed") : handshake(endpoint, now);
}

export const retireNativeSession = ({ binding, runtimeDir }) =>
  removeInboxEndpoint({ runtimeDir, endpointId: binding?.opaqueEndpointRef });

/**
 * Sender side: re-verify the receiver, then write one wake line. The socket
 * answers nothing, so acceptance is a line written to a verified inbox without
 * an error inside the timeout. What the model then sees is recorded by the
 * receiver's own hook.
 */
export async function offerMessage({ binding, message, runtimeDir, timeoutMs = 2_000,
  connect = net.createConnection } = {}) {
  const rejected = safeErrorCode => ({ accepted: false, transport: TRANSPORT,
    clientVersion: binding?.clientVersion ?? null, safeErrorCode });
  if (typeof message?.messageId !== "string" || !MESSAGE_ID.test(message.messageId)) {
    return rejected("transport_rejected");
  }
  const endpoint = await verifiedEndpoint(binding, runtimeDir);
  if (endpoint === null) return rejected("recipient_unavailable");
  const frame = `${JSON.stringify({ type: "user",
    message: { role: "user", content: wakeText(message.messageId) },
    msg_id: `acc-wake-${message.messageId}` })}\n`;
  return new Promise(resolve => {
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
    socket.once("connect", () => socket.end(frame, () =>
      finish({ accepted: true, transport: TRANSPORT, clientVersion: endpoint.clientVersion })));
  });
}
