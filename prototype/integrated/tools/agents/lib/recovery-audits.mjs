import { lstat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { listDirectoryEntries } from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { claimLockDigest, validateClaimAudit } from "./claims-audit.mjs";
import { claimFilePath } from "./claim-records.mjs";
import { readJsonRegularNoFollow } from "./safe-file.mjs";
import { validateLock, validatePresence } from "./schema.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PREFIX = /^(claims-audit-|claims-lock-stale-|doctor-audit-|mutex-audit-|mutex-stale-|watcher-owner-stale-)/;
function data(message) { throw new CommsError(message, EXIT.DATA); }
function validateWatcherOwner(value) {
  const keys = ["acquired_at", "agent_id", "pid", "schema_version", "token"];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== keys.join() || value.schema_version !== 1
    || !UUID_V4.test(value.token)) data("invalid quarantined watcher owner");
  validatePresence({ schema_version: 1, agent_id: value.agent_id, pid: value.pid,
    status: "online", heartbeat_at: value.acquired_at });
  return value;
}
async function readLockGeneration(context, directory) {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) data("unsafe stale claim lock path");
  const snapshot = await readJsonRegularNoFollow(path.join(directory, "owner.json"), validateLock,
    context.paths.root, context.openRecoveryOwner);
  const after = await lstat(directory);
  if (before.dev !== after.dev || before.ino !== after.ino) data("stale claim lock changed");
  return snapshot.record;
}
function isClaimAudit(name) { return name.startsWith("claims-audit-"); }
function isClaimLock(name) { return name.startsWith("claims-lock-stale-"); }
function isWatcherOwner(name) { return name.startsWith("watcher-owner-stale-"); }
export function isRecoveryArtifactPath(context, filePath) {
  return path.dirname(filePath) === context.paths.quarantine && PREFIX.test(path.basename(filePath));
}
async function readClaimIfPresent(context, filePath) {
  try { return (await readJsonRegularNoFollow(filePath, value => value,
    context.paths.root, context.openRecoveryOwner)).record; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function inspectRecoveryAudits(context) {
  const entries = await listDirectoryEntries(context.paths.quarantine,
    { root: context.paths.root, readDirectory: context.readRecoveryDirectory });
  const corrupt = new Set(); const lockAudits = [], pendingForceReleases = [];
  for (const entry of entries.filter(item => isClaimAudit(item.name))) {
    const filePath = path.join(context.paths.quarantine, entry.name);
    try {
      const match = /^claims-audit-([0-9a-f-]+)\.json$/.exec(entry.name);
      if (!UUID_V4.test(match?.[1] ?? "")) data("claims audit filename mismatch");
      const { record } = await readJsonRegularNoFollow(filePath, validateClaimAudit,
        context.paths.root, context.openRecoveryAudit);
      if (record.action === "repair_stale_claim_lock") lockAudits.push({ filePath, record });
      else {
        const source = claimFilePath(context, record.target.scope);
        const active = await readClaimIfPresent(context, source);
        if (active !== null && !isDeepStrictEqual(active, record.target))
          data("force release source generation mismatch");
        if (active !== null) pendingForceReleases.push({ audit_path: filePath,
          source_path: source, audit: record });
      }
    } catch { corrupt.add(filePath); }
  }
  const locks = new Map();
  for (const entry of entries.filter(item => isClaimLock(item.name))) {
    const filePath = path.join(context.paths.quarantine, entry.name);
    try {
      const match = /^claims-lock-stale-([a-f0-9]{64})$/.exec(entry.name);
      if (match === null || !DIGEST.test(match[1])) data("claim lock filename mismatch");
      const owner = await readLockGeneration(context, filePath);
      if (claimLockDigest(owner) !== match[1]) data("claim lock digest mismatch");
      locks.set(match[1], { filePath, owner });
    } catch { corrupt.add(filePath); }
  }
  const matched = new Set(), pendingClaimLocks = [];
  for (const audit of lockAudits) {
    const digest = claimLockDigest(audit.record.target); const generation = locks.get(digest);
    if (generation !== undefined && isDeepStrictEqual(generation.owner, audit.record.target))
      matched.add(digest);
    else if (generation === undefined) try {
      const activePath = path.join(context.paths.locks, "claims.lock");
      const active = await readLockGeneration(context, activePath);
      const stale = context.now().getTime() - Date.parse(active.acquired_at) > 60_000
        && !context.pidIsAlive(active.pid);
      if (!stale || !isDeepStrictEqual(active, audit.record.target))
        data("pending claim lock generation mismatch");
      pendingClaimLocks.push({ audit_path: audit.filePath, source_path: activePath,
        destination_path: path.join(context.paths.quarantine, `claims-lock-stale-${digest}`),
        audit: audit.record });
    } catch { corrupt.add(audit.filePath); }
    else corrupt.add(audit.filePath);
  }
  for (const [digest, generation] of locks) if (!matched.has(digest))
    corrupt.add(generation.filePath);
  for (const entry of entries.filter(item => isWatcherOwner(item.name))) {
    const filePath = path.join(context.paths.quarantine, entry.name);
    try {
      const match = /^watcher-owner-stale-([0-9a-f-]+)\.json$/.exec(entry.name);
      if (!UUID_V4.test(match?.[1] ?? "")) data("watcher owner filename mismatch");
      const { record } = await readJsonRegularNoFollow(filePath, validateWatcherOwner,
        context.paths.root, context.openRecoveryOwner);
      if (record.token !== match[1]) data("watcher owner token mismatch");
    } catch { corrupt.add(filePath); }
  }
  return { corrupt: [...corrupt].sort(), pending_claim_locks: pendingClaimLocks,
    pending_force_releases: pendingForceReleases };
}
export async function scanRecoveryAudits(context) {
  return (await inspectRecoveryAudits(context)).corrupt;
}
export function recoveryIssues(recovery, issue) {
  return [
    ...recovery.pending_claim_locks.map(item => issue("PENDING_CLAIM_LOCK_REPAIR",
      item.audit_path, "claim lock audit awaits its quarantine rename", "warning")),
    ...recovery.pending_force_releases.map(item => issue("PENDING_FORCE_RELEASE",
      item.audit_path, "force-release audit awaits claim removal", "warning")),
  ];
}
