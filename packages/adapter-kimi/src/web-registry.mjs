import os from "node:os";
import path from "node:path";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { closedTo, openRegularNoFollow, versionOrder } from "@agents-can-communicate/adapter-sdk";

import { HEARTBEAT_FRESH_MS, LOCK_FILE_VERSION, LOOPBACK_HOSTS, SERVER_ID, SESSION_ID,
  WEB_DISPLAY_NAME } from "./web-contract.mjs";

// The disk half of the `kimi web` handshake: the server's own instance file,
// the session lock, and the server token. Instance and lock shapes are the
// client's internal formats, so every field is validated against the 2.4.0
// writers and anything unknown fails closed. The token is read per HTTP
// operation and held nowhere: it never enters an endpoint record, a log line,
// or a diagnostic.

const MAX_BYTES = 8_192;
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const CLOCK_SKEW_MS = 5_000;
const LOCK_TOKEN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
const absolute = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");

export const kimiHomeDir = env => absolute(env?.KIMI_CODE_HOME)
  ? env.KIMI_CODE_HOME : path.join(os.homedir(), ".kimi-code");

export const processAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

// A process start that predates the boot or sits in the future is a stale or
// forged record, not a live peer.
const plausibleStart = (at, now, uptimeSeconds = os.uptime()) => Number.isFinite(at)
  && at >= now - uptimeSeconds * 1000 - CLOCK_SKEW_MS && at <= now + CLOCK_SKEW_MS;

async function readJsonFile(file, { platform, privateFile }) {
  let handle;
  try {
    handle = await openRegularNoFollow(file, undefined, { platform });
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > MAX_BYTES
      || (privateFile && !closedTo(info, 0o077, { platform }))) return null;
    const parsed = JSON.parse(await handle.readFile("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

/** One instance record, or null. host_version is required: without it there is
 * no serving version to hold /api/v1/meta to. */
function validInstance(record) {
  return record !== null
    && Object.keys(record).every(key => ["server_id", "pid", "host", "port", "started_at",
      "heartbeat_at", "host_version"].includes(key))
    && typeof record.server_id === "string" && SERVER_ID.test(record.server_id)
    && Number.isInteger(record.pid) && record.pid > 0
    && LOOPBACK_HOSTS.includes(record.host)
    && Number.isInteger(record.port) && record.port >= 1 && record.port <= 65_535
    && Number.isFinite(record.started_at) && Number.isFinite(record.heartbeat_at)
    && typeof record.host_version === "string" && versionOrder(record.host_version) !== null
    ? { serverId: record.server_id, pid: record.pid, host: record.host, port: record.port,
      startedAt: record.started_at, heartbeatAt: record.heartbeat_at, hostVersion: record.host_version }
    : null;
}

/**
 * Live instances under `<home>/server/instances`, freshest heartbeat first.
 * The files carry no secret (kap-server writes them world-readable under the
 * user's umask), so they are owner-checked and bounded but not mode-checked.
 */
export async function readServerInstances({ homeDir, platform = process.platform } = {}) {
  if (!absolute(homeDir)) return [];
  const dir = path.join(homeDir, "server", "instances");
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names.filter(name => SERVER_ID.test(name.replace(/\.json$/, ""))).slice(0, 64)) {
    const instance = validInstance(await readJsonFile(path.join(dir, name), { platform }));
    if (instance !== null) found.push(instance);
  }
  return found.sort((left, right) => right.heartbeatAt - left.heartbeatAt);
}

/**
 * The instance of the server process `clientPid`, uniquely, or null. A fresh
 * heartbeat and a plausible start are required here so a crashed server's
 * unswept file and a pid the machine has since reused both fail closed.
 */
export async function liveServerInstance({ homeDir, clientPid, now = Date.now,
  platform = process.platform, exists = processAlive, uptimeSeconds } = {}) {
  if (!Number.isInteger(clientPid) || clientPid <= 0) return null;
  const matches = (await readServerInstances({ homeDir, platform }))
    .filter(instance => instance.pid === clientPid);
  if (matches.length !== 1) return null;
  const [instance] = matches;
  const at = typeof now === "function" ? now() : now;
  const fresh = instance.heartbeatAt >= at - HEARTBEAT_FRESH_MS
    && instance.heartbeatAt <= at + CLOCK_SKEW_MS;
  return fresh && plausibleStart(instance.startedAt, at, uptimeSeconds) && exists(clientPid)
    ? instance : null;
}

/**
 * The session lock at `<home>/locks/sessions/<id>.lock`, held to the 2.4.0
 * writer: version 1, this machine's hostname, the web client's display name,
 * a token of the writer's `<pid>:<uuid>`, a plausible start, a live pid.
 */
export async function readSessionLock({ homeDir, sessionId, hostname = os.hostname(),
  now = Date.now, platform = process.platform, exists = processAlive, uptimeSeconds } = {}) {
  if (!absolute(homeDir) || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const record = await readJsonFile(path.join(homeDir, "locks", "sessions", `${sessionId}.lock`),
    { platform, privateFile: true });
  if (record === null
    || !Object.keys(record).every(key => ["version", "token", "pid", "hostname", "startedAt",
      "clientIdentity", "clientDisplayName"].includes(key))) return null;
  const [tokenPid, tokenUuid, ...rest] = typeof record.token === "string" ? record.token.split(":") : [];
  const valid = record.version === LOCK_FILE_VERSION
    && Number.isInteger(record.pid) && record.pid > 0
    && String(record.pid) === tokenPid && LOCK_TOKEN_UUID.test(tokenUuid ?? "") && rest.length === 0
    && record.hostname === hostname && record.hostname !== ""
    && record.clientDisplayName === WEB_DISPLAY_NAME
    && plausibleStart(record.startedAt, typeof now === "function" ? now() : now, uptimeSeconds)
    && exists(record.pid);
  return valid ? { pid: record.pid, hostname: record.hostname, startedAt: record.startedAt } : null;
}

/**
 * The current server token, read for one HTTP operation and returned for
 * immediate use only. kap-server itself ignores a token file group or others
 * can read, so this does too; a linked, oversized, or off-charset file is no
 * token. Callers must not store, log, or return the value past the request.
 */
export async function readServerToken({ homeDir, platform = process.platform } = {}) {
  if (!absolute(homeDir)) return null;
  let handle;
  try {
    handle = await openRegularNoFollow(path.join(homeDir, "server.token"), undefined, { platform });
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > 256 || !closedTo(info, 0o077, { platform })) {
      return null;
    }
    const token = (await handle.readFile("utf8")).trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

/**
 * The whole disk verification: the hook's process is the loopback server's
 * process, and that process holds this session's lock as Kimi Code Web. The
 * reason distinguishes a missing server (native_endpoint_unavailable) from a
 * session the server does not hold as a web session (native_session_unavailable).
 */
async function sessionLockPresent(homeDir, sessionId, platform) {
  try {
    await lstat(path.join(homeDir, "locks", "sessions", `${sessionId}.lock`));
    return true;
  } catch {
    return false;
  }
}

export async function verifyWebSession({ homeDir, clientPid, sessionId, allowUnlocked = false,
  platform = process.platform, ...options }) {
  const instance = await liveServerInstance({ homeDir, clientPid, platform, ...options });
  if (instance === null) return { instance: null, lock: null, reason: "native_endpoint_unavailable" };
  const lock = await readSessionLock({ homeDir, sessionId, platform, ...options });
  // Kimi Web holds the lock only during active work. A later hook or a fresh
  // binding lease proves an unloaded-looking session is still warm; an absent
  // lock then is normal, while a present malformed or foreign lock stays fatal.
  if (lock === null && allowUnlocked
    && !await sessionLockPresent(homeDir, sessionId, platform)) return { instance, lock: null, reason: null };
  if (lock === null || lock.pid !== instance.pid) {
    return { instance: null, lock: null, reason: "native_session_unavailable" };
  }
  return { instance, lock, reason: null };
}

/** The session's canonical working directory, or null. */
export async function canonicalCwd(cwd) {
  if (!absolute(cwd)) return null;
  try {
    const resolved = await realpath(cwd);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}
