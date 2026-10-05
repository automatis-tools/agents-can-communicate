import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { closedTo, isWindowsPlatform, openRegularNoFollow } from "@agents-can-communicate/adapter-sdk";

/**
 * Where a running relay is found, and what it may be trusted with.
 *
 * The record is ACC's own: the socket, a nonce that lets a sender hand the relay
 * one envelope, and enough identity to find and retire it. The Antigravity
 * session endpoint - the language-server address and the CSRF token - is never
 * part of it. A key outside the closed list below is refused, so a mistake that
 * tried to persist one fails loudly instead of quietly writing a credential.
 *
 * On Windows the relay listens on a named pipe, `\\.\pipe\acc-relay-<32 hex>`,
 * and the record and its directory carry no mode bits: the profile's ACL keeps
 * them to this user.
 */
export const PROTOCOL_CONTRACT = "antigravity-agentapi-relay-v1";
export const RELAY_MODES = Object.freeze(["livePush", "idleWake", "busyQueue"]);

const KEYS = ["schemaVersion", "endpointId", "conversationId", "agyPid", "relayPid",
  "socketPath", "nonce", "clientVersion", "protocolContract", "modes", "leaseUntil"];
const RELAY_ID = /^antigravity_relay_[a-f0-9]{32}$/;
const CONVERSATION = /^[A-Za-z0-9-]{8,128}$/;
const NONCE = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const LEASE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_BYTES = 4_096;
const RELAY_PIPE = /^\\\\\.\\pipe\\(acc-relay-[0-9a-f]{32})$/;
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
const pid = value => Number.isInteger(value) && value > 0;
const invalid = () => new Error("invalid Antigravity relay registration");

export const relayDir = runtimeDir => path.join(runtimeDir, "native", "antigravity");
export const newRelayId = () => `antigravity_relay_${randomBytes(16).toString("hex")}`;
/** The pipe name a relay pipe path carries, or null. */
export const relayPipeName = value => (typeof value === "string" ? RELAY_PIPE.exec(value)?.[1] ?? null : null);
const socketPathValid = (value, platform) => (isWindowsPlatform(platform) ? relayPipeName(value) !== null
  : typeof value === "string" && path.isAbsolute(value) && Buffer.byteLength(value) < 104);

export function validRegistration(record, { platform = process.platform } = {}) {
  return record !== null && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).length === KEYS.length && KEYS.every(key => Object.hasOwn(record, key))
    && record.schemaVersion === 1 && RELAY_ID.test(record.endpointId)
    && CONVERSATION.test(record.conversationId) && pid(record.agyPid) && pid(record.relayPid)
    && socketPathValid(record.socketPath, platform) && NONCE.test(record.nonce)
    && VERSION.test(record.clientVersion) && record.protocolContract === PROTOCOL_CONTRACT
    && Array.isArray(record.modes) && record.modes.every(mode => RELAY_MODES.includes(mode))
    && typeof record.leaseUntil === "string" && LEASE.test(record.leaseUntil)
    && Number.isFinite(Date.parse(record.leaseUntil));
}

async function directory(runtimeDir, create = false, platform = process.platform) {
  if (typeof runtimeDir !== "string" || !path.isAbsolute(runtimeDir)) throw invalid();
  const dir = relayDir(await realpath(runtimeDir));
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || !own(info) || !closedTo(info, 0o077, { platform })) {
    throw invalid();
  }
  return dir;
}

export async function writeRegistration({ runtimeDir, record, platform = process.platform }) {
  if (!validRegistration(record, { platform })) throw invalid();
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
  return file;
}

export async function readRegistration({ runtimeDir, endpointId, platform = process.platform }) {
  if (typeof endpointId !== "string" || !RELAY_ID.test(endpointId)) return null;
  let handle;
  try {
    const dir = await directory(runtimeDir, false, platform);
    handle = await openRegularNoFollow(path.join(dir, `${endpointId}.json`), undefined, { platform });
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > MAX_BYTES || !closedTo(info, 0o077, { platform })) {
      return null;
    }
    const record = JSON.parse(await handle.readFile("utf8"));
    return validRegistration(record, { platform }) && record.endpointId === endpointId ? record : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

export async function listRegistrations({ runtimeDir, platform = process.platform }) {
  let names;
  try {
    names = await readdir(await directory(runtimeDir, false, platform));
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readRegistration({ runtimeDir, endpointId: name.slice(0, -5), platform });
    if (record !== null) found.push(record);
  }
  return found;
}

export async function removeRegistration({ runtimeDir, endpointId, platform = process.platform }) {
  if (typeof endpointId !== "string" || !RELAY_ID.test(endpointId)) return;
  try {
    await rm(path.join(await directory(runtimeDir, false, platform), `${endpointId}.json`), { force: true });
  } catch { /* retirement is already decided; cleanup is best effort */ }
}
