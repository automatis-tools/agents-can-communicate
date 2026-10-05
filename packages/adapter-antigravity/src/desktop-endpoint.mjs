import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { closedTo, openRegularNoFollow } from "@agents-can-communicate/adapter-sdk";

import { desktopServer, flagValue } from "./client-process.mjs";

/**
 * Where a desktop conversation's live endpoint is, and how it is reached.
 *
 * Antigravity 2.0 serves every conversation from one language server, which
 * takes its CSRF token on its command line. ACC reads that command line when it
 * binds and again each time it delivers, from the one process its own hook ran
 * under, and never writes the token anywhere: the record below holds the
 * server's pid, its start time - so a reused pid is not mistaken for it - and
 * the loopback port that answered, nothing that would let anyone drive it.
 */
export const DESKTOP_PROTOCOL = "antigravity-desktop-agentapi-v1";
export const DESKTOP_MODES = Object.freeze(["livePush", "idleWake", "busyQueue"]);

const KEYS = ["schemaVersion", "endpointId", "conversationId", "serverPid", "serverStartedAt",
  "port", "clientVersion", "protocolContract", "modes", "leaseUntil"];
const ENDPOINT_ID = /^antigravity_desktop_[a-f0-9]{32}$/;
const CONVERSATION = /^[A-Za-z0-9-]{8,128}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const LEASE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
// `ps -o lstart`: "Sun Oct  4 22:55:53 2026", always 24 characters.
const STARTED = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;
const MAX_BYTES = 4_096;
const own = info => typeof process.getuid !== "function" || info.uid === process.getuid();
const isPid = value => Number.isInteger(value) && value > 0;
const invalid = () => new Error("invalid Antigravity desktop endpoint");

export const desktopDir = runtimeDir => path.join(runtimeDir, "native", "antigravity-desktop");
export const newDesktopEndpointId = () => `antigravity_desktop_${randomBytes(16).toString("hex")}`;
export const isDesktopEndpointId = value => typeof value === "string" && ENDPOINT_ID.test(value);

export function validDesktopEndpoint(record) {
  return record !== null && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).length === KEYS.length && KEYS.every(key => Object.hasOwn(record, key))
    && record.schemaVersion === 1 && ENDPOINT_ID.test(record.endpointId)
    && CONVERSATION.test(record.conversationId) && isPid(record.serverPid)
    && typeof record.serverStartedAt === "string" && STARTED.test(record.serverStartedAt)
    && Number.isInteger(record.port) && record.port > 0 && record.port < 65_536
    && VERSION.test(record.clientVersion) && record.protocolContract === DESKTOP_PROTOCOL
    && Array.isArray(record.modes) && record.modes.every(mode => DESKTOP_MODES.includes(mode))
    && typeof record.leaseUntil === "string" && LEASE.test(record.leaseUntil)
    && Number.isFinite(Date.parse(record.leaseUntil));
}

async function directory(runtimeDir, create = false) {
  if (typeof runtimeDir !== "string" || !path.isAbsolute(runtimeDir)) throw invalid();
  const dir = desktopDir(await realpath(runtimeDir));
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || !own(info) || !closedTo(info, 0o077)) throw invalid();
  return dir;
}

export async function writeDesktopEndpoint({ runtimeDir, record }) {
  if (!validDesktopEndpoint(record)) throw invalid();
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
  return file;
}

export async function readDesktopEndpoint({ runtimeDir, endpointId }) {
  if (!isDesktopEndpointId(endpointId)) return null;
  let handle;
  try {
    handle = await openRegularNoFollow(path.join(await directory(runtimeDir), `${endpointId}.json`));
    const info = await handle.stat();
    if (!info.isFile() || !own(info) || info.size > MAX_BYTES || !closedTo(info, 0o077)) return null;
    const record = JSON.parse(await handle.readFile("utf8"));
    return validDesktopEndpoint(record) && record.endpointId === endpointId ? record : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => null);
  }
}

export async function listDesktopEndpoints({ runtimeDir }) {
  let names;
  try {
    names = await readdir(await directory(runtimeDir));
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readDesktopEndpoint({ runtimeDir, endpointId: name.slice(0, -5) });
    if (record !== null) found.push(record);
  }
  return found;
}

export async function removeDesktopEndpoint({ runtimeDir, endpointId }) {
  if (!isDesktopEndpointId(endpointId)) return;
  try {
    await rm(path.join(await directory(runtimeDir), `${endpointId}.json`), { force: true });
  } catch { /* a stale record is refused on read; removal is best effort */ }
}

const runFile = (file, args, { timeout }) => new Promise(resolve => {
  execFile(file, args, { timeout, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1024 * 1024 },
    (error, stdout) => resolve({ ok: error === null, stdout: String(stdout ?? "") }));
});

/**
 * The desktop language server running as `pid`, read from its command line
 * now: when it started, the executable that serves `agentapi`, the version it
 * names and its CSRF token. Null for any other process, a gone one, or a
 * command line that carries no token. The token is returned to the caller for
 * one `agentapi` call and is never stored.
 */
export async function readDesktopServer(pid, { run = runFile, timeoutMs = 1_000,
  platform = process.platform } = {}) {
  // Read through POSIX ps; a Windows desktop build is uncaptured.
  if (!isPid(pid) || platform === "win32") return null;
  const { ok, stdout } = await run("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=,args="],
    { timeout: timeoutMs });
  if (!ok) return null;
  const line = /^(.{24})\s+(.+)$/.exec(stdout.trim());
  if (line === null || !STARTED.test(line[1])) return null;
  const server = desktopServer(line[2]);
  if (server === null) return null;
  const token = flagValue(server.words, "--csrf_token");
  if (typeof token !== "string" || token === "" || token.startsWith("-")) return null;
  return { startedAt: line[1], executable: server.executable, version: server.version, token };
}

// Where lsof lives: /usr/sbin on macOS, /usr/bin on Linux. Never PATH: a
// directory an operator can write to must not supply the tool that names the
// port a token is sent to.
const LSOF_CANDIDATES = Object.freeze(["/usr/sbin/lsof", "/usr/bin/lsof"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

async function resolveLsof() {
  for (const candidate of LSOF_CANDIDATES) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

/** The loopback TCP ports `pid` listens on, in the order lsof lists them. */
export async function listeningPorts(pid, { run = runFile, lsof = resolveLsof, timeoutMs = 1_000 } = {}) {
  const file = await lsof();
  if (file === null || !isPid(pid)) return [];
  const { stdout } = await run(file, ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
    { timeout: timeoutMs });
  const ports = [];
  for (const line of stdout.split("\n")) {
    const match = /^n(.+):(\d+)$/.exec(line.trim());
    if (match === null || !LOOPBACK.has(match[1])) continue;
    const port = Number(match[2]);
    if (port > 0 && port < 65_536 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

/**
 * Whether a loopback port is the server's plain-HTTP endpoint, the one
 * `agentapi` talks to. The server's other port speaks TLS and answers a plain
 * request with 400; the HTTP one answers `/healthz` with 200 (2.19.1). No token
 * is sent.
 */
export function answersHealth(port, { timeoutMs = 500 } = {}) {
  return new Promise(resolve => {
    const request = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: timeoutMs }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
  });
}

/** The first of the server's ports that answers as its HTTP endpoint, or null. */
export async function httpPort(pid, { ports = listeningPorts, health = answersHealth } = {}) {
  for (const port of await ports(pid)) {
    if (await health(port)) return port;
  }
  return null;
}
