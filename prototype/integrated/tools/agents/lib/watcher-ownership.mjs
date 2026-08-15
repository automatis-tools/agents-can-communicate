import { randomUUID } from "node:crypto";
import { link, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readJsonStrict, writeJsonAtomic } from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { withRepairMutex } from "./repair-mutex.mjs";
import { validatePresence } from "./schema.mjs";

const STALE_OWNERSHIP_MS = 60_000;
function ownershipPath(context, agentId) {
  return path.join(context.paths.locks, `watcher-${agentId}.json`);
}
function staleOwnershipPath(context, owner) {
  return path.join(context.paths.quarantine, `watcher-owner-stale-${owner.token}.json`);
}
function validateOwnership(value) {
  const keys = ["acquired_at", "agent_id", "pid", "schema_version", "token"];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== keys.join() || value.schema_version !== 1
    || typeof value.token !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.token)) {
    throw new CommsError("invalid watcher ownership", EXIT.DATA);
  }
  validatePresence({ schema_version: 1, agent_id: value.agent_id, pid: value.pid,
    status: "online", heartbeat_at: value.acquired_at });
  return value;
}
async function readOwnership(context, agentId) {
  try {
    const owner = await readJsonStrict(ownershipPath(context, agentId), validateOwnership);
    if (owner.agent_id !== agentId) {
      throw new CommsError("watcher ownership agent does not match its path", EXIT.DATA,
        { agentId, ownerAgentId: owner.agent_id });
    }
    return owner;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function withMutex(context, agentId, operation) {
  return withRepairMutex(context, "watcher", agentId, operation);
}
async function writePresence(context, agentId, pid, status) {
  const record = validatePresence({ schema_version: 1, agent_id: agentId, pid, status,
    heartbeat_at: context.now().toISOString() });
  await writeJsonAtomic(context.paths.presenceFile(agentId), record,
    { tmpDir: context.paths.tmp, exclusive: false });
}

export async function inspectWatcherOwnership(context, agentId) {
  const owner = await readOwnership(context, agentId);
  if (owner === null) return null;
  const age = context.now().getTime() - Date.parse(owner.acquired_at);
  return Object.freeze({ owner,
    repairable: age > STALE_OWNERSHIP_MS && !context.pidIsAlive(owner.pid) });
}

export async function acquireWatcherOwnership(context, agentId, pid) {
  return withMutex(context, agentId, async () => {
    const owner = validateOwnership({ schema_version: 1, agent_id: agentId, pid,
      token: (context.randomUUID ?? randomUUID)(),
      acquired_at: context.now().toISOString() });
    try {
      await writeJsonAtomic(ownershipPath(context, agentId), owner,
        { tmpDir: context.paths.tmp, exclusive: true });
    } catch (error) {
      if (!(error instanceof CommsError) || error.exitCode !== EXIT.CONFLICT) throw error;
      await readOwnership(context, agentId);
      throw new CommsError("agent id already has a watcher owner", EXIT.CONFLICT, { agentId });
    }
    try { await writePresence(context, agentId, pid, "online"); }
    catch (error) {
      const current = await readOwnership(context, agentId);
      if (current?.token === owner.token) await unlink(ownershipPath(context, agentId));
      throw error;
    }
    return owner;
  });
}

async function writeIfOwner(context, owner, status, release) {
  const current = await readOwnership(context, owner.agent_id);
  if (current === null || current.token !== owner.token) return false;
  await writePresence(context, owner.agent_id, owner.pid, status);
  if (release) await unlink(ownershipPath(context, owner.agent_id));
  return true;
}
export async function writePresenceIfWatcherOwner(context, owner, status, release = false) {
  if (!release) return writeIfOwner(context, owner, status, false);
  return withMutex(context, owner.agent_id,
    () => writeIfOwner(context, owner, status, true));
}

export async function repairStaleWatcherOwnership(context, agentId) {
  return withMutex(context, agentId, async () => {
    const inspected = await inspectWatcherOwnership(context, agentId);
    if (inspected === null || !inspected.repairable) return false;
    const active = ownershipPath(context, agentId);
    const destination = staleOwnershipPath(context, inspected.owner);
    try { await (context.linkWatcherOwner ?? link)(active, destination); }
    catch (error) {
      if (error.code === "ENOENT") return false;
      if (error.code !== "EEXIST") throw error;
      const quarantined = await readJsonStrict(destination, validateOwnership);
      if (!isDeepStrictEqual(quarantined, inspected.owner)) return false;
    }
    const [current, quarantined] = await Promise.all([
      readOwnership(context, agentId), readJsonStrict(destination, validateOwnership) ]);
    if (current === null || !isDeepStrictEqual(current, inspected.owner)
      || !isDeepStrictEqual(quarantined, inspected.owner)) return false;
    await unlink(active);
    return true;
  });
}
