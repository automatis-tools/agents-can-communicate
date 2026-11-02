import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { closedTo, openRegularNoFollow, versionOrder } from "@agents-can-communicate/adapter-sdk";

import { processAlive } from "./web-registry.mjs";
import { LOOPBACK_HOSTS, PROTOCOL_CONTRACT, SERVER_ID, SESSION_ID } from "./web-contract.mjs";

// One private record per hook binding, the way the other adapters keep their
// native endpoints: core holds only the random id, and the server, session and
// workspace identity stays in a 0600 file under the workspace runtime
// directory. The record carries no token - neither the server's auth token
// nor the session lock's - so reading it grants nothing but re-verification.

const KEYS = ["schemaVersion", "endpointId", "kimiHome", "serverId", "serverPid", "host", "port",
  "startedAt", "metaServerId", "metaStartedAt", "clientVersion", "sessionId", "cwd", "hostname",
  "protocolContract", "leaseUntil"];
const ENDPOINT = /^kimi_web_[a-f0-9]{32}$/;
const MAX_BYTES = 8_192;
const absolute = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
const invalid = () => new Error("invalid Kimi web endpoint registration");

export const newEndpointId = () => `kimi_web_${randomBytes(16).toString("hex")}`;
export const ENDPOINTS_DIRECTORY = "kimi-web-endpoints";

function valid(record) {
  return record !== null && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).length === KEYS.length && KEYS.every(key => Object.hasOwn(record, key))
    && record.schemaVersion === 1 && ENDPOINT.test(record.endpointId)
    && absolute(record.kimiHome)
    && typeof record.serverId === "string" && SERVER_ID.test(record.serverId)
    && Number.isInteger(record.serverPid) && record.serverPid > 0
    && LOOPBACK_HOSTS.includes(record.host)
    && Number.isInteger(record.port) && record.port >= 1 && record.port <= 65_535
    && Number.isInteger(record.startedAt) && record.startedAt > 0
    && typeof record.metaServerId === "string" && SERVER_ID.test(record.metaServerId)
    && Number.isInteger(record.metaStartedAt) && record.metaStartedAt >= record.startedAt
    && typeof record.clientVersion === "string" && versionOrder(record.clientVersion) !== null
    && typeof record.sessionId === "string" && SESSION_ID.test(record.sessionId)
    && absolute(record.cwd)
    && typeof record.hostname === "string" && record.hostname !== "" && record.hostname.length <= 255
    && record.protocolContract === PROTOCOL_CONTRACT
    && typeof record.leaseUntil === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.leaseUntil)
    && Number.isFinite(Date.parse(record.leaseUntil));
}

async function directory(runtimeDir, create = false, platform = process.platform) {
  if (!absolute(runtimeDir)) throw invalid();
  if (create) await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const root = await realpath(runtimeDir);
  const dir = path.join(root, ENDPOINTS_DIRECTORY);
  if (create) await mkdir(dir, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || !own(info) || !closedTo(info, 0o022, { platform })) {
    throw invalid();
  }
  return dir;
}

// A fresh, immutable registration per bind: refresh re-verifies the record;
// it never overwrites a successor's random endpoint.
export async function writeWebEndpoint({ runtimeDir, record, platform = process.platform }) {
  if (!valid(record)) throw invalid();
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) throw invalid();
  const dir = await directory(runtimeDir, true, platform);
  const file = path.join(dir, `${record.endpointId}.json`);
  const temporary = path.join(dir, `.${record.endpointId}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.close(); handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close().catch(() => null);
    await rm(temporary, { force: true }).catch(() => null);
  }
}

// An expired record is metadata for re-verification, never proof of reach.
export async function readWebEndpoint({ runtimeDir, endpointId, platform = process.platform }) {
  if (typeof endpointId !== "string" || !ENDPOINT.test(endpointId)) return null;
  let handle;
  try {
    const dir = await directory(runtimeDir, false, platform);
    handle = await openRegularNoFollow(path.join(dir, `${endpointId}.json`), undefined, { platform });
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > MAX_BYTES || !closedTo(info, 0o077, { platform })) {
      return null;
    }
    const record = JSON.parse(await handle.readFile("utf8"));
    return valid(record) && record.endpointId === endpointId ? record : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

export async function removeWebEndpoint({ runtimeDir, endpointId, platform = process.platform }) {
  if (typeof endpointId !== "string" || !ENDPOINT.test(endpointId)) return;
  try {
    const dir = await directory(runtimeDir, false, platform);
    await rm(path.join(dir, `${endpointId}.json`), { force: true });
  } catch { /* retirement is already recorded; cleanup is best effort */ }
  try {
    await rm(path.join(await wakesDirectory(runtimeDir, false, platform), endpointId),
      { recursive: true, force: true });
  } catch { /* the same */ }
}

// A crashed server ran no shutdown, so its bindings were never retired. Only
// a record whose process is gone is removed.
export async function sweepDeadEndpoints({ runtimeDir, exists = processAlive, limit = 64,
  platform = process.platform }) {
  let names;
  try {
    names = await readdir(await directory(runtimeDir, false, platform));
  } catch {
    return;
  }
  for (const name of names.filter(item => /^kimi_web_[a-f0-9]{32}\.json$/.test(item)).slice(0, limit)) {
    const endpointId = name.slice(0, -".json".length);
    const record = await readWebEndpoint({ runtimeDir, endpointId, platform });
    if (record !== null && !exists(record.serverPid)) {
      await removeWebEndpoint({ runtimeDir, endpointId, platform });
    }
  }
}

// One empty marker per message a binding woke. A wake leaves the receipt
// queued until the receiver's own UserPromptSubmit hook projects the body, so
// an outcome ACC cannot confirm must never be blindly retried: the marker is
// kept on any ambiguous result and released only after a definite pre-send
// failure, keeping delivery at most once per message and binding.
const WAKE_MESSAGE = /^[A-Za-z0-9_-]{1,200}$/;

async function wakesDirectory(runtimeDir, create = false, platform = process.platform) {
  const dir = path.join(path.dirname(await directory(runtimeDir, create, platform)), "kimi-web-wakes");
  if (create) await mkdir(dir, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || !own(info) || !closedTo(info, 0o022, { platform })) {
    throw invalid();
  }
  return dir;
}

/** True when this call is the first to wake the binding for the message. */
export async function claimWake({ runtimeDir, endpointId, messageId, platform = process.platform }) {
  if (!ENDPOINT.test(endpointId) || !WAKE_MESSAGE.test(messageId)) throw invalid();
  const dir = path.join(await wakesDirectory(runtimeDir, true, platform), endpointId);
  await mkdir(dir, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  try {
    await (await open(path.join(dir, messageId), "wx", 0o600)).close();
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

const OUTCOMES = ["queued", "running", "ambiguous"];
// Beside the marker, never inside it: a message id has no dot, so the name
// cannot be another message's marker.
const outcomeName = messageId => `${messageId}.outcome`;

/** Persist how the first submit ended, so a duplicate offer can repeat it. */
export async function recordWake({ runtimeDir, endpointId, messageId, outcome,
  platform = process.platform }) {
  if (!ENDPOINT.test(endpointId) || !WAKE_MESSAGE.test(messageId) || !OUTCOMES.includes(outcome)) return;
  let handle;
  try {
    const dir = path.join(await wakesDirectory(runtimeDir, false, platform), endpointId);
    // Only beside a marker this binding claimed; an outcome is never invented.
    if (!(await lstat(path.join(dir, messageId))).isFile()) return;
    // Exclusive creation follows no link and replaces nothing, on every
    // platform; the first outcome recorded is the one a duplicate repeats.
    handle = await open(path.join(dir, outcomeName(messageId)), "wx", 0o600);
    await handle.writeFile(outcome);
  } catch { /* no outcome only makes a duplicate answer conservatively */ } finally {
    await handle?.close().catch(() => null);
  }
}

/** Recorded outcome of the claim, or null while the first offer is unresolved. */
export async function readWakeOutcome({ runtimeDir, endpointId, messageId, platform = process.platform }) {
  if (!ENDPOINT.test(endpointId) || !WAKE_MESSAGE.test(messageId)) return null;
  let handle;
  try {
    handle = await openRegularNoFollow(path.join(await wakesDirectory(runtimeDir, false, platform),
      endpointId, outcomeName(messageId)), constants.O_RDONLY, { platform });
    const text = await handle.readFile("utf8");
    return OUTCOMES.includes(text) ? text : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

export async function releaseWake({ runtimeDir, endpointId, messageId, platform = process.platform }) {
  if (!ENDPOINT.test(endpointId) || !WAKE_MESSAGE.test(messageId)) return;
  try {
    const dir = path.join(await wakesDirectory(runtimeDir, false, platform), endpointId);
    await rm(path.join(dir, outcomeName(messageId)), { force: true });
    await rm(path.join(dir, messageId), { force: true });
  } catch { /* a marker left behind only suppresses a repeat wake */ }
}
