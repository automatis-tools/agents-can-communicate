import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { PROTOCOL_CONTRACT } from "./inbox-contract.mjs";
import { inboxSocketIsSafe } from "./inbox-registry.mjs";

// One private record per hook binding, the way the Codex adapter keeps its
// daemon endpoints: core holds only the random id, and the socket path, pid and
// session id stay in a 0600 file under the workspace runtime directory.

const KEYS = ["schemaVersion", "endpointId", "socketPath", "configDir", "clientPid", "sessionId",
  "clientVersion", "protocolContract", "leaseUntil"];
const ENDPOINT = /^claude_inbox_[a-f0-9]{32}$/;
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_BYTES = 8_192;
const absolute = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
const invalid = () => new Error("invalid Claude inbox endpoint registration");

export const newEndpointId = () => `claude_inbox_${randomBytes(16).toString("hex")}`;

function valid(record) {
  return record !== null && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).length === KEYS.length && KEYS.every(key => Object.hasOwn(record, key))
    && record.schemaVersion === 1 && ENDPOINT.test(record.endpointId)
    && absolute(record.socketPath) && absolute(record.configDir)
    && Number.isInteger(record.clientPid) && record.clientPid > 0
    && typeof record.sessionId === "string" && record.sessionId !== "" && record.sessionId.length <= 200
    && typeof record.clientVersion === "string" && STABLE.test(record.clientVersion)
    && record.protocolContract === PROTOCOL_CONTRACT
    && typeof record.leaseUntil === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.leaseUntil)
    && Number.isFinite(Date.parse(record.leaseUntil));
}

async function directory(runtimeDir, create = false) {
  if (!absolute(runtimeDir)) throw invalid();
  if (create) await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const root = await realpath(runtimeDir);
  const dir = path.join(root, "claude-inbox-endpoints");
  if (create) await mkdir(dir, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || !own(info) || (info.mode & 0o022) !== 0) throw invalid();
  return dir;
}

export async function writeInboxEndpoint({ runtimeDir, record }) {
  if (!valid(record) || !await inboxSocketIsSafe(record.socketPath)) throw invalid();
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) throw invalid();
  const dir = await directory(runtimeDir, true);
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
export async function readInboxEndpoint({ runtimeDir, endpointId }) {
  if (typeof endpointId !== "string" || !ENDPOINT.test(endpointId)) return null;
  let handle;
  try {
    const dir = await directory(runtimeDir);
    handle = await open(path.join(dir, `${endpointId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > MAX_BYTES || (info.mode & 0o077) !== 0) return null;
    const record = JSON.parse(await handle.readFile("utf8"));
    return valid(record) && record.endpointId === endpointId ? record : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

export async function removeInboxEndpoint({ runtimeDir, endpointId }) {
  if (typeof endpointId !== "string" || !ENDPOINT.test(endpointId)) return;
  try {
    const dir = await directory(runtimeDir);
    await rm(path.join(dir, `${endpointId}.json`), { force: true });
  } catch { /* retirement is already recorded; cleanup is best effort */ }
}
