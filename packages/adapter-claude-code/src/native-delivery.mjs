import { readFile, readdir, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { PROTOCOL_CONTRACT, endpointDir, isSocketSafe, readRegistration, routeAck, routeReply }
  from "./channel.mjs";

// The five native-delivery adapter methods for Claude Code. They keep every
// Claude flag, protocol name, and endpoint detail inside this package and hand
// core only opaque facts: a probe verdict, an activation plan, a handshake with
// an opaque endpoint id, and an offer result. offerMessage is the sender-side
// half - it connects to the receiver's session endpoint and delivers one
// envelope; the Channel process itself turns acc_reply into a real ACC answer.

const MIN_VERSION = "2.1.258";
const CHANNEL_PLUGIN = "plugin:agents-can-communicate@acc-local";
const DEV_CHANNEL_FLAG = "--dangerously-load-development-channels";
// The bytes the installed 2.1.258 Mach-O carries for the Channel MCP protocol;
// a build without Channels has neither. Read-only, bounded.
const PROBE_NEEDLE = Buffer.from("notifications/claude/channel");
const PROBE_MAX_BYTES = 256 * 1024 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;

function compare(left, right) {
  const a = left.split("+")[0].split(".").map(Number);
  const b = right.split("+")[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

async function executableHasChannel(realExecutable) {
  let handle;
  try {
    handle = await (await import("node:fs/promises")).open(realExecutable, "r");
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0);
    let read = 0;
    let position = 0;
    do {
      ({ bytesRead: read } = await handle.read(chunk, 0, chunk.length, position));
      if (read === 0) break;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      if (window.includes(PROBE_NEEDLE)) return true;
      carry = window.subarray(Math.max(0, window.length - PROBE_NEEDLE.length));
      position += read;
    } while (position < PROBE_MAX_BYTES);
    return false;
  } finally {
    await handle.close().catch(() => null);
  }
}

// Read-only: a stable version at or above the minimum whose executable carries
// the Channel protocol. Never launches the client.
export async function probeNativeDelivery({ realExecutable, timeoutMs = 750,
  hasChannel = executableHasChannel, readVersion = defaultReadVersion } = {}) {
  const unsupported = reasonCode => ({ supported: false, clientVersion: null,
    protocolContract: PROTOCOL_CONTRACT, executableFingerprint: null, modes: [], reasonCode });
  if (typeof realExecutable !== "string" || realExecutable === "") return unsupported("feature_probe_failed");
  const clientVersion = await withTimeout(readVersion(realExecutable, timeoutMs), timeoutMs)
    .catch(() => null);
  if (clientVersion === null || !STABLE_VERSION.test(clientVersion)) {
    return { ...unsupported("feature_probe_failed"), clientVersion };
  }
  if (compare(clientVersion, MIN_VERSION) < 0) {
    return { ...unsupported("below_minimum_version"), clientVersion };
  }
  const present = await withTimeout(Promise.resolve(hasChannel(realExecutable)), timeoutMs)
    .catch(() => false);
  if (!present) return { ...unsupported("protocol_mismatch"), clientVersion };
  return { supported: true, clientVersion, protocolContract: PROTOCOL_CONTRACT,
    executableFingerprint: null, modes: ["livePush", "idleWake", "busyQueue", "replyRoute"],
    reasonCode: null };
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

// The shell bootstrap adds only the captured Channel flag; the .mcp.json the
// adapter's own install writes is the native-config artifact. ACC never
// suppresses Claude's experimental warning.
export function planNativeActivation({ detection, livePolicy }) {
  if (detection?.realExecutable === undefined || detection.realExecutable === null) {
    return { eligible: false, reasonCode: "feature_probe_failed", mechanisms: [] };
  }
  void livePolicy;
  return { eligible: true, reasonCode: null, mechanisms: [
    { kind: "native-config", artifactIds: ["claude-channel-mcp"] },
    { kind: "shell-bootstrap", command: "claude", realExecutable: detection.realExecutable,
      prefixArgs: [DEV_CHANNEL_FLAG, CHANNEL_PLUGIN] },
  ] };
}

async function currentRegistrations(runtimeDir) {
  const dir = endpointDir(runtimeDir);
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const registrations = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = readRegistration(await readFile(path.join(dir, name), "utf8"));
      registrations.push(record);
    } catch { /* skip a malformed neighbour */ }
  }
  return registrations;
}

// Bind the exact Channel the hook-resolved Claude process owns: match clientPid,
// verify the protocol, and return an opaque endpoint id. Never selects the first
// registration; two Claude sessions cannot receive each other's endpoint.
export async function bindNativeSession({ clientPid, clientVersion, runtimeDir, timeoutMs = 750,
  intervalMs = 50, now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const closed = reasonCode => ({ supported: false, clientVersion: clientVersion ?? null,
    protocolContract: PROTOCOL_CONTRACT, modes: [], opaqueEndpointRef: null, leaseUntil: null,
    reasonCode });
  if (!Number.isInteger(clientPid) || clientPid <= 0) return closed("handshake_failed");
  // Both sides of this handshake are started by SessionStart: the hook writes
  // the session binding and then calls here, while the Channel is still waiting
  // for that same binding before it can listen and register. So the endpoint
  // reliably appears after this begins, and a single read gave up on a channel
  // that was moments from ready - measured, a healthy endpoint landed on disk
  // just after the hook had already recorded no binding at all.
  //
  // The budget was always passed in for this. It stops one interval short of
  // the hook's own timer, which races the same budget: an answer that arrives
  // together with that timer is a coin toss the session loses.
  const deadline = now() + Math.max(0, timeoutMs - intervalMs);
  for (;;) {
    const matches = (await currentRegistrations(runtimeDir))
      .filter(record => record.clientPid === clientPid
        && record.protocolContract === PROTOCOL_CONTRACT
        && Date.parse(record.leaseUntil) > Date.now());
    // Exactly one, still: waiting must not relax the rule that two Claude
    // sessions can never be handed each other's endpoint.
    if (matches.length === 1 && isSocketSafe(matches[0].socketPath)) {
      const [record] = matches;
      return { supported: true, clientVersion: clientVersion ?? null,
        protocolContract: PROTOCOL_CONTRACT, modes: [...record.modes],
        opaqueEndpointRef: record.endpointId, leaseUntil: record.leaseUntil, reasonCode: null };
    }
    if (now() >= deadline) return closed("handshake_failed");
    await sleep(intervalMs);
  }
}

// Sender side: resolve the endpoint id to its registration under this
// workspace's runtime dir, connect to the session-scoped socket, and deliver one
// envelope. Returns only accepted/duplicate plus the bound client version.
export async function offerMessage({ binding, message, runtimeDir, timeoutMs = 2_000,
  connect = net.createConnection }) {
  const rejected = safeErrorCode => ({ accepted: false, transport: "claude-channel",
    clientVersion: binding?.clientVersion ?? null, safeErrorCode });
  if (typeof runtimeDir !== "string" || binding?.opaqueEndpointRef === undefined) {
    return rejected("recipient_unavailable");
  }
  const file = path.join(endpointDir(runtimeDir), `${binding.opaqueEndpointRef}.json`);
  if (path.dirname(file) !== endpointDir(runtimeDir)) return rejected("recipient_unavailable");
  let record;
  try {
    record = readRegistration(await readFile(file, "utf8"));
  } catch {
    return rejected("recipient_unavailable");
  }
  if (record.endpointId !== binding.opaqueEndpointRef
    || record.protocolContract !== PROTOCOL_CONTRACT
    || Date.parse(record.leaseUntil) <= Date.now()
    || !(await stat(record.socketPath).then(s => s.isSocket(), () => false))
    || !isSocketSafe(record.socketPath)) {
    return rejected("recipient_unavailable");
  }
  return sendEnvelope({ record, message, binding, connect, timeoutMs, rejected });
}

function sendEnvelope({ record, message, binding, connect, timeoutMs, rejected }) {
  const envelope = { nonce: record.nonce, messageId: message.messageId, kind: message.kind,
    subject: message.subject ?? "", body: message.body ?? "",
    ...(typeof message.inReplyTo === "string" ? { inReplyTo: message.inReplyTo } : {}) };
  return new Promise(resolve => {
    const socket = connect(record.socketPath);
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer);
      socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(rejected("transport_error")), timeoutMs);
    socket.once("error", () => finish(rejected("recipient_unavailable")));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(envelope)}\n`);
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        let response;
        try { response = JSON.parse(buffer.slice(0, newline)); }
        catch { return finish(rejected("transport_rejected")); }
        if (response.accepted === true) {
          return finish({ accepted: true, transport: "claude-channel",
            clientVersion: binding.clientVersion });
        }
        finish(rejected("transport_rejected"));
      });
    });
  });
}

export { MIN_VERSION, endpointDir, routeAck, routeReply };
