import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWindowsPlatform as isWindows, openRegularNoFollow } from "@agents-can-communicate/adapter-sdk";

// Claude Code's own record of a live session: `<config>/sessions/<pid>.json`
// names the session id and the inbox it listens on. On POSIX the inbox is a
// socket only this user can open, and ACC reads that file and nothing beside it.
// On Windows the inbox is a named pipe that refuses a frame without an auth
// line, and Claude publishes a key for other sessions of the same user beside
// the record: `<pid>.<sha256 of the lowercased pipe path>.key` (measured on
// 2.1.286). ACC reads that peer key there, so a wake is classified a peer's and
// the recipient's inbound settings apply; it never reads the session's own
// messaging token, which would pass as the session's child.

const MAX_BYTES = 16_384;
const KEY_MAX_BYTES = 4_096;
const INBOX_PIPE = /^\\\\\.\\pipe\\((?:LOCAL\\)?cc-msg-[0-9a-f]{32})$/i;
const PEER_TOKEN = /^[0-9a-f]{32}$/;
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
const text = value => (typeof value === "string" && value !== "" ? value : null);

export const claudeConfigDir = env => typeof env?.CLAUDE_CONFIG_DIR === "string"
  && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
  ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), ".claude");

/** Whether a value names a Claude Code inbox pipe. */
export const isInboxPipe = value => typeof value === "string" && INBOX_PIPE.test(value);

export const listPipesOfMachine = () => readdir("\\\\.\\pipe\\");

/** The registry entry for one pid, or null. Bounded, owner-checked, never through a link. */
export async function readSessionRecord({ configDir, clientPid, platform = process.platform }) {
  if (!Number.isInteger(clientPid) || clientPid <= 0 || typeof configDir !== "string") return null;
  const windows = isWindows(platform);
  const paths = windows ? path.win32 : path;
  let handle;
  try {
    handle = await openRegularNoFollow(path.join(configDir, "sessions", `${clientPid}.json`),
      undefined, { platform });
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > MAX_BYTES) return null;
    const record = JSON.parse(await handle.readFile("utf8"));
    const inbox = typeof record?.messagingSocketPath === "string" && (windows
      ? INBOX_PIPE.test(record.messagingSocketPath) : paths.isAbsolute(record.messagingSocketPath));
    return record?.pid === clientPid && typeof record.sessionId === "string" && record.sessionId !== ""
      && inbox
      ? { pid: record.pid, sessionId: record.sessionId, messagingSocketPath: record.messagingSocketPath,
        cwd: typeof record.cwd === "string" && paths.isAbsolute(record.cwd) ? record.cwd : null,
        ...(windows ? { procStart: text(record.procStart), pidDomain: text(record.pidDomain) } : {}) }
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

/**
 * A socket this user owns, reached without a link, closed to group and others.
 * On Windows a Claude inbox pipe the machine lists: its name is 128 random bits
 * that only this user's profile records.
 */
export async function inboxSocketIsSafe(socketPath, { platform = process.platform,
  listPipes = listPipesOfMachine } = {}) {
  if (isWindows(platform)) {
    const name = INBOX_PIPE.exec(typeof socketPath === "string" ? socketPath : "")?.[1]?.toLowerCase();
    if (name === undefined) return false;
    const pipes = await Promise.resolve().then(listPipes).catch(() => []);
    return pipes.some(pipe => String(pipe).toLowerCase() === name);
  }
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
export async function verifyInbox({ configDir, clientPid, sessionId, socketPath, anyConversation = false,
  platform = process.platform, listPipes = listPipesOfMachine }) {
  if (!await inboxSocketIsSafe(socketPath, { platform, listPipes })) return "native_endpoint_unavailable";
  const record = await readSessionRecord({ configDir, clientPid, platform });
  if (record === null || (!anyConversation && record.sessionId !== sessionId)) {
    return "native_session_unavailable";
  }
  // A pipe has no path to resolve; Windows compares its name without case.
  if (isWindows(platform)) {
    return record.messagingSocketPath.toLowerCase() === socketPath.toLowerCase()
      ? null : "native_session_unavailable";
  }
  const [registered, expected] = await Promise.all([
    realpath(record.messagingSocketPath).catch(() => null), realpath(socketPath).catch(() => null)]);
  return registered !== null && registered === expected ? null : "native_session_unavailable";
}

/**
 * Windows: the token Claude published for peers of this session, or null. The
 * key's name binds it to this pid and this pipe, and its process start has to
 * be the one the session record gives, so a key left by an earlier process
 * that held the pid is never used. Read per offer, never stored by ACC.
 */
export async function readPeerKey({ configDir, record }) {
  if (typeof configDir !== "string" || typeof record?.messagingSocketPath !== "string"
    || !Number.isInteger(record.pid) || text(record.procStart) === null) return null;
  const digest = createHash("sha256").update(record.messagingSocketPath.toLowerCase()).digest("hex");
  let handle;
  try {
    handle = await openRegularNoFollow(path.join(configDir, "sessions", `${record.pid}.${digest}.key`),
      undefined, { platform: "win32" });
    const info = await handle.stat();
    if (!info.isFile() || info.size > KEY_MAX_BYTES) return null;
    const key = JSON.parse(await handle.readFile("utf8"));
    const started = text(key?.procStartFt) ?? text(key?.procStart);
    const domain = record.pidDomain === null || key?.pidDomain === record.pidDomain;
    return PEER_TOKEN.test(key?.peerToken ?? "") && started === record.procStart && domain
      ? key.peerToken : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}
