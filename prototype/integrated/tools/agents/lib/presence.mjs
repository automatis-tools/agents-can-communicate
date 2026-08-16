import { watch as fsWatch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { CommsError, EXIT } from "./errors.mjs";
import { requireOpenAgent } from "./identity.mjs";
import { listInbox, markSeen } from "./messages.mjs";
import { validatePresence } from "./schema.mjs";
import {
  acquireWatcherOwnership, inspectWatcherOwnership, repairStaleWatcherOwnership,
  writePresenceIfWatcherOwner,
} from "./watcher-ownership.mjs";
export { inspectWatcherOwnership, repairStaleWatcherOwnership };
const STALE_HEARTBEAT_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SCAN_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_SCHEDULER = Object.freeze({
  setInterval: (callback, delay) => setInterval(callback, delay),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearInterval: handle => clearInterval(handle),
  clearTimeout: handle => clearTimeout(handle),
});
function duration(value, fallback, name, minimum = 1) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum) {
    throw new CommsError(`${name} must be an integer of at least ${minimum}`, EXIT.DATA);
  }
  return result;
}
function defaultOutput(event) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(event)}\n\u0007`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
function messageEvent(message) {
  return Object.freeze({ event: "message", message, state: "unseen" });
}
export function presenceState(record, now, pidIsAlive) {
  const presence = validatePresence(record);
  if (presence.status === "offline" || !pidIsAlive(presence.pid)) return "offline";
  return now.getTime() - Date.parse(presence.heartbeat_at) > STALE_HEARTBEAT_MS
    ? "stale"
    : "online";
}
export async function startWatcher(context, input) {
  const registry = await requireOpenAgent(context, input.agentId);
  const agentId = registry.agent_id;
  const pid = input.pid ?? context.pid ?? process.pid;
  const scheduler = context.scheduler ?? DEFAULT_SCHEDULER;
  const watchDirectory = context.watchDirectory ?? fsWatch;
  const output = context.output ?? defaultOutput;
  const heartbeatMs = duration(input.heartbeatMs, DEFAULT_HEARTBEAT_MS, "heartbeat");
  const scanIntervalMs = duration(input.scanIntervalMs, DEFAULT_SCAN_INTERVAL_MS,
    "scan interval");
  const printed = new Set();
  let stopped = false;
  let fileWatcher = null;
  let scanHandle = null;
  let heartbeatHandle = null;
  let scanTail = Promise.resolve();
  let heartbeatTail = Promise.resolve();
  let terminalPromise = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    [resolveDone, rejectDone] = [resolve, reject];
  });
  done.catch(() => undefined);
  let ownership = null;
  async function scanInbox() {
    const items = await listInbox(context, { agentId });
    for (const item of items) {
      if (item.state !== "unseen" || printed.has(item.message.id)) continue;
      await output(messageEvent(item.message));
      printed.add(item.message.id);
      await markSeen(context, item.message, agentId);
    }
  }
  async function heartbeat() {
    if (!await writePresenceIfWatcherOwner(context, ownership, "online")) {
      throw new CommsError("watcher ownership was lost", EXIT.CONFLICT, { agentId });
    }
    await context.extendOwnedClaims(agentId);
  }
  function queueScan() {
    const task = scanTail.then(() => stopped ? undefined : scanInbox());
    scanTail = task.catch(() => undefined);
    task.catch(error => { void terminate(error); });
    return task;
  }
  function queueHeartbeat() {
    const task = heartbeatTail.then(() => stopped ? undefined : heartbeat());
    heartbeatTail = task.catch(() => undefined);
    task.catch(error => { void terminate(error); });
    return task;
  }
  function closeEventSources() {
    if (scanHandle !== null) scheduler.clearInterval(scanHandle);
    if (heartbeatHandle !== null) scheduler.clearInterval(heartbeatHandle);
    fileWatcher?.close();
  }
  function terminate(error = null) {
    if (terminalPromise !== null) return terminalPromise;
    stopped = true;
    closeEventSources();
    terminalPromise = (async () => {
      await scanTail;
      await heartbeatTail;
      try {
        await writePresenceIfWatcherOwner(context, ownership, "offline", true);
      } catch (offlineError) {
        rejectDone(error ?? offlineError);
        throw offlineError;
      }
      if (error === null) resolveDone();
      else rejectDone(error);
    })();
    return terminalPromise;
  }
  ownership = await acquireWatcherOwnership(context, agentId, pid,
    () => requireOpenAgent(context, agentId));
  heartbeatHandle = scheduler.setInterval(() => queueHeartbeat().catch(() => undefined),
    heartbeatMs);
  try {
    await context.extendOwnedClaims(agentId);
    await mkdir(context.paths.inboxDir(agentId), { recursive: true });
    fileWatcher = watchDirectory(context.paths.inboxDir(agentId),
      () => queueScan().catch(() => undefined));
    if (typeof fileWatcher.once === "function") {
      fileWatcher.once("error", error => { void terminate(error); });
    }
    await queueScan();
  } catch (error) {
    await terminate(error);
    throw error;
  }
  scanHandle = scheduler.setInterval(() => queueScan().catch(() => undefined),
    scanIntervalMs);
  return Object.freeze({ stop: () => terminate(), done });
}

export async function waitForMessage(context, input) {
  const agentId = (await requireOpenAgent(context, input.agentId)).agent_id;
  const scheduler = context.scheduler ?? DEFAULT_SCHEDULER;
  const watchDirectory = context.watchDirectory ?? fsWatch;
  const readInbox = context.listInbox ?? (request => listInbox(context, request));
  const timeoutMs = duration(input.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, "timeout", 0);
  const scanIntervalMs = duration(input.scanIntervalMs, DEFAULT_SCAN_INTERVAL_MS,
    "scan interval");
  await mkdir(context.paths.inboxDir(agentId), { recursive: true });

  let settled = false;
  let fileWatcher = null;
  let timeoutHandle = null;
  let scanHandle = null;
  let scanTail = Promise.resolve();
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    [resolveResult, rejectResult] = [resolve, reject];
  });

  function cleanup() {
    fileWatcher?.close();
    if (timeoutHandle !== null) scheduler.clearTimeout(timeoutHandle);
    if (scanHandle !== null) scheduler.clearInterval(scanHandle);
  }

  function finish(value, error = null) {
    if (settled) return;
    settled = true;
    cleanup();
    if (error === null) resolveResult(value);
    else rejectResult(error);
  }

  async function scan() {
    const unseen = (await readInbox({ agentId }))
      .find(item => item.state === "unseen");
    if (unseen !== undefined) finish(unseen.message);
  }

  function queueScan() {
    const task = scanTail.then(() => settled ? undefined : scan());
    scanTail = task.catch(() => undefined);
    task.catch(error => finish(null, error));
    return task;
  }

  fileWatcher = watchDirectory(context.paths.inboxDir(agentId),
    () => queueScan().catch(() => undefined));
  if (typeof fileWatcher.once === "function") {
    fileWatcher.once("error", error => finish(null, error));
  }
  await queueScan().catch(() => undefined);
  await scanTail;
  if (settled) return result;
  timeoutHandle = scheduler.setTimeout(() => finish(null), timeoutMs);
  scanHandle = scheduler.setInterval(() => queueScan().catch(() => undefined),
    scanIntervalMs);
  return result;
}
