import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Claude Code's own record of a live session: `<config>/sessions/<pid>.json`
// names the session id and the inbox socket it listens on. ACC reads that file
// and nothing beside it - never the `<pid>.<hash>.key` next to it.

const MAX_BYTES = 16_384;
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();

export const claudeConfigDir = env => typeof env?.CLAUDE_CONFIG_DIR === "string"
  && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
  ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), ".claude");

/** The registry entry for one pid, or null. Bounded, owner-checked, never through a link. */
export async function readSessionRecord({ configDir, clientPid }) {
  if (!Number.isInteger(clientPid) || clientPid <= 0 || typeof configDir !== "string") return null;
  let handle;
  try {
    handle = await open(path.join(configDir, "sessions", `${clientPid}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > MAX_BYTES) return null;
    const record = JSON.parse(await handle.readFile("utf8"));
    return record?.pid === clientPid && typeof record.sessionId === "string" && record.sessionId !== ""
      && typeof record.messagingSocketPath === "string" && path.isAbsolute(record.messagingSocketPath)
      ? { pid: record.pid, sessionId: record.sessionId, messagingSocketPath: record.messagingSocketPath,
        cwd: typeof record.cwd === "string" && path.isAbsolute(record.cwd) ? record.cwd : null }
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

/** A socket this user owns, reached without a link, closed to group and others. */
export async function inboxSocketIsSafe(socketPath) {
  if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) return false;
  try {
    const info = await lstat(socketPath);
    return info.isSocket() && !info.isSymbolicLink() && own(info) && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether this socket is the inbox of this session, right now.
 *
 * The socket path alone proves nothing: pids are reused, and a new process
 * gets a new registry entry under the same name. Requiring the registry to
 * name both this session id and this socket is what keeps a wake from reaching
 * whatever process holds the pid later. Returns null, or the reason it is not.
 *
 * `anyConversation` is for the bind alone. Claude Code runs SessionStart for a
 * /resume before it rewrites the entry, so there the hook's own process and
 * socket are the proof; every offer and refresh still requires the session id.
 */
export async function verifyInbox({ configDir, clientPid, sessionId, socketPath, anyConversation = false }) {
  if (!await inboxSocketIsSafe(socketPath)) return "native_endpoint_unavailable";
  const record = await readSessionRecord({ configDir, clientPid });
  if (record === null || (!anyConversation && record.sessionId !== sessionId)) {
    return "native_session_unavailable";
  }
  const [registered, expected] = await Promise.all([
    realpath(record.messagingSocketPath).catch(() => null), realpath(socketPath).catch(() => null)]);
  return registered !== null && registered === expected ? null : "native_session_unavailable";
}
