import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { closedTo, isWindowsPlatform, openRegularNoFollow } from "@agents-can-communicate/adapter-sdk";

import { PROTOCOL_CONTRACT, versionOrder } from "./app-server-client.mjs";

const KEYS = ["schemaVersion", "endpointId", "socketPath", "threadId", "cwd",
  "clientVersion", "protocolContract", "leaseUntil"];
const ENDPOINT = /^codex_endpoint_[a-f0-9]{32}$/;
const MAX_BYTES = 8_192;
const absolute = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
const invalid = () => new Error("invalid Codex endpoint registration");

export const newEndpointId = () => `codex_endpoint_${randomBytes(16).toString("hex")}`;

function valid(record) {
  return record !== null && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).length === KEYS.length && KEYS.every(key => Object.hasOwn(record, key))
    && record.schemaVersion === 1 && ENDPOINT.test(record.endpointId)
    && absolute(record.socketPath) && absolute(record.cwd)
    && typeof record.threadId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(record.threadId)
    && versionOrder(record.clientVersion) !== null
    && record.protocolContract === PROTOCOL_CONTRACT
    && typeof record.leaseUntil === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.leaseUntil)
    && Number.isFinite(Date.parse(record.leaseUntil));
}

async function directory(runtimeDir, create = false, platform = process.platform) {
  if (!absolute(runtimeDir)) throw invalid();
  if (create) await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const root = await realpath(runtimeDir);
  const dir = path.join(root, "codex-native-endpoints");
  if (create) await mkdir(dir, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || !own(info) || !closedTo(info, 0o022, { platform })) {
    throw invalid();
  }
  return dir;
}

/**
 * An owned socket, never itself a link. On Windows Node's lstat refuses the
 * daemon's AF_UNIX socket file with EACCES (measured on windows-latest, Codex
 * 0.159.3), so there the socket counts while its directory lists it; Codex keeps
 * that directory to its user.
 */
export async function socketIsReady(socketPath, { platform = process.platform } = {}) {
  if (isWindowsPlatform(platform)) {
    if (!absolute(socketPath)) return false;
    const name = path.basename(socketPath).toLowerCase();
    const names = await readdir(path.dirname(socketPath)).catch(() => []);
    return names.some(entry => entry.toLowerCase() === name);
  }
  if (!absolute(socketPath)) return false;
  try {
    const info = await lstat(socketPath);
    return info.isSocket() && !info.isSymbolicLink() && own(info);
  } catch { return false; }
}

/** The socket a control socket path leads to, or null. Codex 0.157.1 keeps a
 * symlink at the path it reports and the socket itself under /private/tmp
 * (measured 2026-09-26), so the path is followed once and the socket at its
 * end is held to socketIsReady: an owned socket, never itself a link. */
export async function readySocketPath(socketPath, { platform = process.platform } = {}) {
  if (isWindowsPlatform(platform)) {
    // The socket file itself refuses to be opened; its directory resolves.
    if (!absolute(socketPath)) return null;
    const directory = await realpath(path.dirname(socketPath)).catch(() => null);
    const resolved = directory === null ? null : path.join(directory, path.basename(socketPath));
    return resolved !== null && await socketIsReady(resolved, { platform }) ? resolved : null;
  }
  if (!absolute(socketPath)) return null;
  const resolved = await realpath(socketPath).catch(() => null);
  return resolved !== null && await socketIsReady(resolved) ? resolved : null;
}

// A fresh, immutable registration for one hook binding. Refresh observes the
// same registration again; it cannot overwrite a successor's random endpoint.
export async function writeNativeEndpoint({ runtimeDir, record, platform = process.platform }) {
  if (!valid(record) || !await socketIsReady(record.socketPath, { platform })) throw invalid();
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

// Expired records are metadata for revalidation, never proof of reachability.
// Refuse links and oversized files before reading; no foreign error text escapes.
export async function readNativeEndpoint({ runtimeDir, endpointId, platform = process.platform }) {
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
  } catch { return null; }
  finally { await handle?.close().catch(() => null); }
}

export async function removeNativeEndpoint({ runtimeDir, endpointId, platform = process.platform }) {
  if (typeof endpointId !== "string" || !ENDPOINT.test(endpointId)) return;
  try {
    const dir = await directory(runtimeDir, false, platform);
    await rm(path.join(dir, `${endpointId}.json`), { force: true });
  } catch { /* retirement is already recorded; cleanup is best effort */ }
}
