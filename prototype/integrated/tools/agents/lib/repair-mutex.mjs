import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { listDirectoryEntries, writeJsonAtomic } from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { readJsonRegularNoFollow } from "./safe-file.mjs";
import { validateAgentId } from "./schema.mjs";

const STALE_MS = 60_000;
const ATTEMPTS = 10_000;
function key(kind, agentId) { return kind === "doctor" ? "doctor" : `watcher-${agentId}`; }
export function repairMutexPath(context, kind, agentId = null) {
  if (kind !== "doctor" && kind !== "watcher") throw new TypeError("invalid mutex kind");
  if (kind === "watcher") validateAgentId(agentId);
  return path.join(context.paths.locks, `${key(kind, agentId)}.lock`);
}
function ownerPath(directory) { return path.join(directory, "owner.json"); }
function validateOwner(value) {
  const keys = ["acquired_at", "agent_id", "kind", "pid", "schema_version", "token"];
  const timestamp = Date.parse(value?.acquired_at);
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== keys.join() || value.schema_version !== 1
    || !["doctor", "watcher"].includes(value.kind)
    || (value.kind === "doctor" ? value.agent_id !== null : !value.agent_id)
    || !Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== value.acquired_at
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.token))
    throw new CommsError("invalid repair mutex owner", EXIT.DATA);
  if (value.agent_id !== null) validateAgentId(value.agent_id);
  return value;
}
async function readOwnerSnapshot(context, directory) {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("unsafe mutex path");
  const snapshot = await readJsonRegularNoFollow(ownerPath(directory), validateOwner,
    context.paths.root, context.openMutexOwner);
  const after = await lstat(directory);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("mutex changed");
  return { owner: snapshot.record, bytes: snapshot.bytes };
}
function bound(owner, kind, agentId) {
  return owner.kind === kind && owner.agent_id === (kind === "doctor" ? null : agentId);
}
export async function inspectRepairMutex(context, kind, agentId = null) {
  const directory = repairMutexPath(context, kind, agentId);
  try {
    const { owner, bytes } = await readOwnerSnapshot(context, directory);
    if (!bound(owner, kind, agentId)) throw new Error("mutex owner does not match path");
    const age = context.now().getTime() - Date.parse(owner.acquired_at);
    const state = context.pidIsAlive(owner.pid) ? "live" : age > STALE_MS ? "stale" : "young";
    return { state, owner, owner_sha256: createHash("sha256").update(bytes).digest("hex"),
      path: directory };
  } catch (error) {
    if (error.code === "ENOENT") {
      try { await lstat(directory); return { state: "corrupt", owner: null, path: directory }; }
      catch (missing) { if (missing.code === "ENOENT") return null; throw missing; }
    }
    return { state: "corrupt", owner: null, path: directory };
  }
}
async function wait(context, kind) {
  if (context.waitRepairMutex !== undefined) return context.waitRepairMutex(kind);
  return new Promise(resolve => setImmediate(resolve));
}
async function acquire(context, kind, agentId) {
  const token = (context.randomMutexUUID ?? randomUUID)();
  const active = repairMutexPath(context, kind, agentId);
  const prepared = path.join(context.paths.tmp, `mutex-${token}`);
  const owner = validateOwner({ schema_version: 1, kind,
    agent_id: kind === "doctor" ? null : agentId, pid: context.pid ?? process.pid,
    token, acquired_at: context.now().toISOString() });
  await mkdir(prepared);
  try {
    await writeJsonAtomic(ownerPath(prepared), owner, { tmpDir: context.paths.tmp, exclusive: true });
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) try {
      await rename(prepared, active); return { active, owner };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      await wait(context, kind);
    }
    throw new CommsError("repair mutex is unavailable", EXIT.CONFLICT, { path: active });
  } catch (error) {
    try { await unlink(ownerPath(prepared)); } catch {}
    try { await rmdir(prepared); } catch {}
    throw error;
  }
}
async function release(context, acquired) {
  let current;
  try { current = (await readOwnerSnapshot(context, acquired.active)).owner; }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (current.token !== acquired.owner.token) return;
  const retired = path.join(context.paths.tmp, `mutex-release-${current.token}`);
  try { await rename(acquired.active, retired); }
  catch (error) { if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return; throw error; }
  await unlink(ownerPath(retired)); await rmdir(retired);
}
export async function withRepairMutex(context, kind, agentId, operation) {
  const acquired = await acquire(context, kind, agentId);
  try { return await operation(acquired.owner); }
  finally { await release(context, acquired); }
}
function stalePaths(context, owner) {
  const digest = createHash("sha256").update(JSON.stringify(owner)).digest("hex");
  return { destination: path.join(context.paths.quarantine, `mutex-stale-${digest}`),
    audit: path.join(context.paths.quarantine, `mutex-audit-${digest}.json`) };
}
function validateAudit(value) {
  const keys = ["action", "owner_sha256", "quarantine_path", "recorded_at",
    "schema_version", "target"];
  const timestamp = Date.parse(value?.recorded_at);
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== keys.join() || value.schema_version !== 1
    || value.action !== "repair_stale_mutex" || !path.isAbsolute(value.quarantine_path)
    || !/^[a-f0-9]{64}$/.test(value.owner_sha256)
    || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.recorded_at)
    throw new CommsError("invalid repair mutex audit", EXIT.DATA);
  validateOwner(value.target);
  return value;
}
export async function scanRepairMutexAudits(context) {
  const corrupt = [];
  const entries = await listDirectoryEntries(context.paths.quarantine,
    { root: context.paths.root });
  const names = new Set(entries.map(entry => entry.name));
  for (const entry of entries.filter(item => item.name.startsWith("mutex-audit-"))) {
    const auditPath = path.join(context.paths.quarantine, entry.name);
    try {
      const { record: audit } = await readJsonRegularNoFollow(auditPath, validateAudit,
        context.paths.root, context.openMutexAudit);
      const match = /^mutex-audit-([a-f0-9]{64})\.json$/.exec(entry.name);
      const digest = createHash("sha256").update(JSON.stringify(audit.target)).digest("hex");
      const destination = path.join(context.paths.quarantine, `mutex-stale-${digest}`);
      if (match?.[1] !== digest || audit.quarantine_path !== destination)
        throw new Error("mutex audit binding mismatch");
      let snapshot, ownerSha;
      try { snapshot = await readOwnerSnapshot(context, destination);
        ownerSha = createHash("sha256").update(snapshot.bytes).digest("hex"); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        try { await lstat(destination); throw new Error("mutex quarantine owner is missing"); }
        catch (missing) { if (missing.code !== "ENOENT") throw missing; }
        const pending = await inspectRepairMutex(context, audit.target.kind, audit.target.agent_id);
        if (pending?.state !== "stale") throw error;
        snapshot = { owner: pending.owner }; ownerSha = pending.owner_sha256;
      }
      if (!isDeepStrictEqual(snapshot.owner, audit.target) || ownerSha !== audit.owner_sha256)
        throw new Error("mutex audit target mismatch");
    } catch { corrupt.push(auditPath); }
  }
  for (const entry of entries.filter(item => item.name.startsWith("mutex-stale-"))) {
    const match = /^mutex-stale-([a-f0-9]{64})$/.exec(entry.name);
    if (match === null || !names.has(`mutex-audit-${match[1]}.json`)) corrupt.push(
      path.join(context.paths.quarantine, entry.name));
  }
  return [...new Set(corrupt)].sort();
}
export async function repairStaleRepairMutex(context, kind, agentId = null) {
  const inspected = await inspectRepairMutex(context, kind, agentId);
  if (inspected?.state !== "stale") return false;
  const paths = stalePaths(context, inspected.owner);
  const audit = validateAudit({ schema_version: 1, action: "repair_stale_mutex",
    recorded_at: context.now().toISOString(), target: inspected.owner,
    owner_sha256: inspected.owner_sha256, quarantine_path: paths.destination });
  try { await writeJsonAtomic(paths.audit, audit, { tmpDir: context.paths.tmp, exclusive: true }); }
  catch (error) {
    if (!(error instanceof CommsError) || error.exitCode !== EXIT.CONFLICT) throw error;
    const { record: existing } = await readJsonRegularNoFollow(paths.audit, validateAudit,
      context.paths.root, context.openMutexAudit);
    if (!isDeepStrictEqual(existing, { ...audit, recorded_at: existing.recorded_at })) throw error;
  }
  try { await (context.renameRepairMutex ?? rename)(inspected.path, paths.destination); }
  catch (error) {
    if (!["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error.code)) throw error;
    return false;
  }
  const moved = await readOwnerSnapshot(context, paths.destination);
  if (!isDeepStrictEqual(moved.owner, inspected.owner)
    || createHash("sha256").update(moved.bytes).digest("hex") !== inspected.owner_sha256)
    throw new CommsError("repaired mutex generation changed", EXIT.DATA);
  return true;
}
