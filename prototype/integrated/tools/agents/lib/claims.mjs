import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { readJsonStrict, writeJsonAtomic } from "./atomic-json.mjs";
import { claimFilePath, requireValidClaimRecords } from "./claim-records.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { requireOpenAgent } from "./identity.mjs";
import {
  validateAgentId,
  validateClaim,
  validateLock,
  validateScope,
} from "./schema.mjs";

const DEFAULT_LEASE_SECONDS = 1_800;
const STALE_LOCK_MS = 60_000;
function conflict(message, details = null) {
  throw new CommsError(message, EXIT.CONFLICT, details);
}
function canonicalScope(scope) {
  const normalized = normalizeScope(scope);
  return normalized.kind === "contract"
    ? `contract:${normalized.value}`
    : normalized.value;
}
function inputAgentId(input) {
  return validateAgentId(input.agentId ?? input.agent_id);
}
function ownerAgentId(input) {
  return validateAgentId(input.ownerAgent ?? input.owner_agent ?? input.owner);
}
function leaseSeconds(input) {
  const value = input.leaseSeconds ?? input.lease ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CommsError("claim lease must be a positive integer", EXIT.DATA, { value });
  }
  return value;
}
function claimLockPaths(context) {
  const directory = path.join(context.paths.locks, "claims.lock");
  return { directory, owner: path.join(directory, "owner.json") };
}
async function removeIfPresent(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}
async function readLockIfPresent(paths) {
  try {
    return await readJsonStrict(paths.owner, validateLock);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function acquireClaimLock(context, agentId) {
  const paths = claimLockPaths(context);
  try {
    await mkdir(paths.directory);
  } catch (error) {
    if (error.code === "EEXIST") {
      conflict("claim lock is already held", { lock: paths.directory });
    }
    throw error;
  }
  const record = validateLock({
    schema_version: 1,
    owner_agent: validateAgentId(agentId),
    pid: context.pid ?? process.pid,
    acquired_at: context.now().toISOString(),
  });
  const writeOwner = context.writeClaimLockOwner ?? writeJsonAtomic;
  try {
    await writeOwner(paths.owner, record, {
      tmpDir: context.paths.tmp,
      exclusive: true,
    });
  } catch (error) {
    try { await removeIfPresent(paths.owner); } catch {}
    try { await rmdir(paths.directory); } catch {}
    throw error;
  }
  return paths;
}
async function releaseClaimLock(paths) {
  await removeIfPresent(paths.owner);
  try {
    await rmdir(paths.directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function withClaimLock(context, agentId, operation) {
  const lock = await acquireClaimLock(context, agentId);
  try {
    return await operation();
  } finally {
    await releaseClaimLock(lock);
  }
}
function expiresAt(context, seconds = DEFAULT_LEASE_SECONDS) {
  return new Date(context.now().getTime() + seconds * 1_000).toISOString();
}
function claimIsStale(claim, context) {
  return Date.parse(claim.expires_at) <= context.now().getTime();
}
function auditName(context) {
  const uuid = (context.randomUUID ?? randomUUID)();
  return path.join(context.paths.quarantine, `claims-audit-${uuid}.json`);
}
function validateAudit(value) {
  const keys = ["action", "actor_agent", "recorded_at", "schema_version", "target"];
  const validShape = value.schema_version === 1
    && Object.keys(value).sort().join() === keys.join();
  const timestamp = Date.parse(value.recorded_at);
  if (!validShape || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== value.recorded_at) {
    throw new CommsError("invalid claims audit", EXIT.DATA);
  }
  if (value.actor_agent !== null) validateAgentId(value.actor_agent);
  if (value.action === "force_release_stale_claim") validateClaim(value.target);
  else if (value.action === "repair_stale_claim_lock") validateLock(value.target);
  else throw new CommsError("invalid claims audit action", EXIT.DATA);
  return value;
}
async function writeAudit(context, action, actorAgent, target) {
  const audit = validateAudit({
    schema_version: 1,
    action,
    actor_agent: actorAgent,
    recorded_at: context.now().toISOString(),
    target,
  });
  await writeJsonAtomic(auditName(context), audit, {
    tmpDir: context.paths.tmp,
    exclusive: true,
  });
}
function staleLockDestination(context, owner) {
  const canonical = JSON.stringify([
    owner.schema_version, owner.owner_agent, owner.pid, owner.acquired_at,
  ]);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return path.join(context.paths.quarantine, `claims-lock-stale-${digest}`);
}
function findExactClaim(items, scope) {
  return items.find(item => item.record.scope === scope) ?? null;
}
export function normalizeScope(scope) {
  const value = validateScope(scope);
  if (value.startsWith("contract:")) {
    return Object.freeze({ kind: "contract", value: value.slice("contract:".length) });
  }
  return Object.freeze({ kind: "path", value: value.replace(/\/$/, "") });
}
export function scopesOverlap(leftInput, rightInput) {
  const left = normalizeScope(leftInput);
  const right = normalizeScope(rightInput);
  if (left.kind !== right.kind) return false;
  if (left.kind === "contract") return left.value === right.value;
  const a = left.value.split("/");
  const b = right.value.split("/");
  return a.slice(0, Math.min(a.length, b.length))
    .every((part, index) => part === b[index]);
}
export async function claimScope(context, input) {
  const agentId = inputAgentId(input);
  const scope = canonicalScope(input.scope);
  const registry = await requireOpenAgent(context, agentId);
  const seconds = leaseSeconds(input);
  return withClaimLock(context, agentId, async () => {
    const items = await requireValidClaimRecords(context);
    const exact = findExactClaim(items, scope);
    const blocking = items.find(item => item.record.agent_id !== agentId
      && scopesOverlap(item.record.scope, scope));
    if (blocking !== undefined) {
      conflict("scope overlaps an existing claim", {
        owner: blocking.record.agent_id,
        scope: blocking.record.scope,
        stale: claimIsStale(blocking.record, context),
      });
    }

    const timestamp = context.now().toISOString();
    const record = validateClaim({
      schema_version: 1,
      agent_id: agentId,
      task: registry.task,
      scope,
      reason: input.reason,
      created_at: exact?.record.created_at ?? timestamp,
      updated_at: timestamp,
      expires_at: expiresAt(context, seconds),
    });
    await writeJsonAtomic(claimFilePath(context, scope), record, {
      tmpDir: context.paths.tmp,
      exclusive: exact === null,
    });
    return record;
  });
}
export async function releaseScope(context, input) {
  const agentId = inputAgentId(input);
  const scope = canonicalScope(input.scope);
  await requireOpenAgent(context, agentId);
  return withClaimLock(context, agentId, async () => {
    const claim = findExactClaim(await requireValidClaimRecords(context), scope);
    if (claim === null || claim.record.agent_id !== agentId) {
      conflict("scope is not claimed by this agent", { agentId, scope });
    }
    await unlink(claim.file);
    return claim.record;
  });
}
export async function releaseOwnedClaims(context, agentId) {
  const owner = validateAgentId(agentId);
  return withClaimLock(context, owner, async () => {
    const owned = (await requireValidClaimRecords(context))
      .filter(item => item.record.agent_id === owner);
    for (const item of owned) await unlink(item.file);
    return owned.map(item => item.record);
  });
}
export async function extendClaims(context, agentId) {
  const owner = (await requireOpenAgent(context, validateAgentId(agentId))).agent_id;
  return withClaimLock(context, owner, async () => {
    const owned = (await requireValidClaimRecords(context))
      .filter(item => item.record.agent_id === owner);
    const timestamp = context.now().toISOString();
    const extended = [];
    for (const item of owned) {
      const record = validateClaim({
        ...item.record,
        updated_at: timestamp,
        expires_at: expiresAt(context),
      });
      await writeJsonAtomic(item.file, record, {
        tmpDir: context.paths.tmp,
        exclusive: false,
      });
      extended.push(record);
    }
    return extended;
  });
}
export async function forceReleaseStaleScope(context, input) {
  const actor = await requireOpenAgent(context, inputAgentId(input));
  if (actor.role !== "orchestrator") {
    conflict("only an orchestrator may force-release a stale claim", {
      agentId: actor.agent_id,
    });
  }
  const owner = ownerAgentId(input);
  const scope = canonicalScope(input.scope);
  return withClaimLock(context, actor.agent_id, async () => {
    const claim = findExactClaim(await requireValidClaimRecords(context), scope);
    if (claim === null || claim.record.agent_id !== owner) {
      conflict("target claim does not exist", { owner, scope });
    }
    if (!claimIsStale(claim.record, context)) {
      conflict("active claim cannot be force-released", { owner, scope });
    }
    await writeAudit(context, "force_release_stale_claim", actor.agent_id, claim.record);
    await unlink(claim.file);
    return claim.record;
  });
}
export async function repairStaleClaimLock(context) {
  const paths = claimLockPaths(context);
  const owner = await readLockIfPresent(paths);
  if (owner === null) return false;
  const age = context.now().getTime() - Date.parse(owner.acquired_at);
  if (age <= STALE_LOCK_MS || context.pidIsAlive(owner.pid)) return false;
  await writeAudit(context, "repair_stale_claim_lock", null, owner);
  const destination = staleLockDestination(context, owner);
  try {
    await (context.renameClaimLock ?? rename)(paths.directory, destination);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error.code)) throw error;
    await readLockIfPresent(paths);
    return false;
  }
  return true;
}
