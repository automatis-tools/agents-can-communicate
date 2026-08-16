import { access } from "node:fs/promises";
import path from "node:path";
import { listDirectoryEntries, listJsonFiles, readJsonStrict } from "./atomic-json.mjs";
import { inspectClaimRecords } from "./claim-records.mjs";
import { repairPendingForceReleases, repairStaleClaimLock } from "./claims.mjs";
import { archiveAcknowledged, quarantineCorrupt, scanDoctorAudits }
  from "./doctor-storage.mjs";
import { protocolCompatibilityIssue } from "./doctor-protocol.mjs";
import { EXIT } from "./errors.mjs";
import { inspectWatcherOwnership, presenceState, repairStaleWatcherOwnership } from "./presence.mjs";
import { inspectRecoveryAudits, isRecoveryArtifactPath, recoveryIssues }
  from "./recovery-audits.mjs";
import { repairStaleRepairMutex, scanRepairMutexAudits, withRepairMutex } from "./repair-mutex.mjs";
import { collectMutexStatus, mutexIssues, repairStaleWatcherMutexes } from "./status-locks.mjs";
import { validateAcknowledgement, validateHandoff, validateLock,
  validateMessage, validatePresence, validateProtocol, validateRegistry,
  validateSeenReceipt } from "./schema.mjs";
async function exists(filePath) { try { await access(filePath); return true; } catch (error) {
  if (error.code === "ENOENT") return false; throw error; } }
function addCorrupt(state, filePath) { if (!state.corrupt.includes(filePath)) state.corrupt.push(filePath); }
async function safeRead(context, filePath, validate, state) {
  try { return await readJsonStrict(filePath, validate, context.paths.root); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    addCorrupt(state, filePath);
    return null; }
}
async function nestedJsonFiles(context, root) {
  const entries = await listDirectoryEntries(root, { root: context.paths.root });
  const directories = entries.filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  return (await Promise.all(directories.map(entry =>
    listJsonFiles(path.join(root, entry.name), { root: context.paths.root })))).flat();
}
function fileStem(filePath) { return path.basename(filePath, ".json"); }
function sortRecords(records, field) { return records.sort((a, b) => a[field].localeCompare(b[field])); }
async function readProtocol(context, state) {
  const record = await safeRead(context, context.paths.protocol, validateProtocol, state);
  if (record === null) {
    addCorrupt(state, context.paths.protocol);
    return { schema_version: null, protocol_version: null, checkout_id: null };
  }
  return { schema_version: record.schema_version,
    protocol_version: record.protocol_version, checkout_id: record.checkout_id };
}
async function readAgents(context, state) {
  const presence = new Map();
  for (const filePath of await listJsonFiles(context.paths.presence, { root: context.paths.root })) {
    const record = await safeRead(context, filePath, validatePresence, state);
    if (record === null) continue;
    if (fileStem(filePath) !== record.agent_id) { addCorrupt(state, filePath); continue; }
    presence.set(record.agent_id, record);
  }
  const agents = { live: [], stale: [], offline: [] };
  for (const filePath of await listJsonFiles(context.paths.registry, { root: context.paths.root })) {
    const registry = await safeRead(context, filePath, validateRegistry, state);
    if (registry === null) continue;
    if (fileStem(filePath) !== registry.agent_id) { addCorrupt(state, filePath); continue; }
    const heartbeat = presence.get(registry.agent_id) ?? null;
    presence.delete(registry.agent_id);
    let status = "offline";
    if (registry.status === "open" && heartbeat !== null)
      status = presenceState(heartbeat, context.now(), context.pidIsAlive);
    else if (registry.status === "open"
      && context.now().getTime() - Date.parse(registry.updated_at) > 45_000) status = "stale";
    agents[status === "online" ? "live" : status].push(registry);
  }
  for (const orphan of presence.values()) addCorrupt(state,
    context.paths.presenceFile(orphan.agent_id));
  for (const records of Object.values(agents)) sortRecords(records, "agent_id");
  return agents;
}
function messageKey(message) { return `${message.to}/${message.id}`; }
async function readMessages(context, state) {
  const stored = new Map();
  for (const [location, root] of [["inbox", context.paths.inbox],
    ["archive", context.paths.archive]]) {
    for (const filePath of await nestedJsonFiles(context, root)) {
      const message = await safeRead(context, filePath, validateMessage, state);
      if (message === null) continue;
      const recipient = path.basename(path.dirname(filePath));
      if (recipient !== message.to || fileStem(filePath) !== message.id
        || stored.has(messageKey(message))) { addCorrupt(state, filePath); continue; }
      stored.set(messageKey(message), { message, location, filePath });
    }
  }
  return stored;
}
async function readReceipts(context, state, stored, kind) {
  const acknowledgements = kind === "ack";
  const root = acknowledgements ? context.paths.acknowledgements : context.paths.seen;
  const validate = acknowledgements ? validateAcknowledgement : validateSeenReceipt;
  const records = new Map();
  for (const filePath of await listJsonFiles(root, { root: context.paths.root })) {
    const receipt = await safeRead(context, filePath, validate, state);
    if (receipt === null) continue;
    const expected = acknowledgements
      ? context.paths.ackFile(receipt.message_id, receipt.recipient)
      : context.paths.seenFile(receipt.message_id, receipt.recipient);
    const key = `${receipt.recipient}/${receipt.message_id}`;
    if (filePath !== expected || !stored.has(key)) { addCorrupt(state, filePath); continue; }
    records.set(key, receipt);
  }
  return records;
}
async function messageStatus(context, state) {
  const stored = await readMessages(context, state);
  const seen = await readReceipts(context, state, stored, "seen");
  const acknowledged = await readReceipts(context, state, stored, "ack");
  const messages = { unseen: [], seen_but_unacked: [], required_unacked: [],
    blockers: [], acknowledgements: [] };
  for (const [key, item] of stored) {
    const acknowledgement = acknowledged.get(key);
    if (acknowledgement !== undefined) {
      messages.acknowledgements.push({ message: item.message, acknowledgement,
        location: item.location });
      continue;
    }
    if (item.location !== "inbox") { addCorrupt(state, item.filePath); continue; }
    messages[seen.has(key) ? "seen_but_unacked" : "unseen"].push(item.message);
    if (item.message.requires_ack) messages.required_unacked.push(item.message);
    if (item.message.severity === "blocker") messages.blockers.push(item.message);
  }
  for (const name of ["unseen", "seen_but_unacked", "required_unacked", "blockers"])
    sortRecords(messages[name], "id");
  messages.acknowledgements.sort((a, b) => a.message.id.localeCompare(b.message.id));
  return messages;
}
async function readClaims(context, state) {
  const claims = { active: [], stale: [] };
  const inspected = await inspectClaimRecords(context);
  for (const filePath of inspected.corrupt) addCorrupt(state, filePath);
  for (const item of inspected.records) claims[
    Date.parse(item.record.expires_at) <= context.now().getTime() ? "stale" : "active"]
    .push(item.record);
  sortRecords(claims.active, "scope"); sortRecords(claims.stale, "scope");
  return claims;
}
async function readHandoffs(context, state) {
  const records = [];
  for (const filePath of await listJsonFiles(context.paths.handoffs, { root: context.paths.root })) {
    const record = await safeRead(context, filePath, validateHandoff, state);
    if (record !== null && fileStem(filePath) === record.id) records.push(record);
    else if (record !== null) addCorrupt(state, filePath);
  }
  return sortRecords(records, "id");
}
function counts(report) {
  return {
    live_agents: report.agents.live.length, stale_agents: report.agents.stale.length,
    offline_agents: report.agents.offline.length, unseen: report.messages.unseen.length,
    seen_but_unacked: report.messages.seen_but_unacked.length, required_unacked: report.messages.required_unacked.length,
    blockers: report.messages.blockers.length, acknowledgements: report.messages.acknowledgements.length,
    active_claims: report.claims.active.length, stale_claims: report.claims.stale.length,
    handoffs: report.handoffs.length, corrupt: report.corrupt.length,
  };
}
async function readLockCorruption(context, state) {
  const ownerPath = path.join(context.paths.locks, "claims.lock", "owner.json");
  if (await exists(ownerPath)) await safeRead(context, ownerPath, validateLock, state);
  for (const agentId of await watcherIds(context)) try {
    await inspectWatcherOwnership(context, agentId);
  } catch { addCorrupt(state,
    path.join(context.paths.locks, `watcher-${agentId}.json`)); }
}
export async function collectStatus(context) {
  const state = { corrupt: [] }, recovery = await inspectRecoveryAudits(context);
  await readLockCorruption(context, state);
  for (const auditPath of [...await scanDoctorAudits(context), ...await scanRepairMutexAudits(context),
    ...recovery.corrupt]) addCorrupt(state, auditPath);
  const report = { protocol: await readProtocol(context, state),
    agents: await readAgents(context, state),
    messages: await messageStatus(context, state), claims: await readClaims(context, state),
    handoffs: await readHandoffs(context, state), recovery, locks: await collectMutexStatus(context),
    corrupt: state.corrupt.sort() };
  report.counts = counts(report);
  return report;
}
function issue(code, filePath, message, severity = "error") {
  return { code, severity, path: filePath, message }; }
async function watcherIds(context) {
  const entries = await listDirectoryEntries(context.paths.locks, { root: context.paths.root });
  return entries.filter(entry => entry.isFile() && /^watcher-.+\.json$/.test(entry.name))
    .map(entry => entry.name.slice(8, -5)).sort();
}
async function operationalIssues(context, report, input) {
  const issues = [];
  const protocolMissing = !await exists(context.paths.protocol);
  const protectedProtocol = !protocolMissing && report.corrupt.includes(context.paths.protocol)
    ? await protocolCompatibilityIssue(context) : null;
  if (protocolMissing) issues.push(issue("PROTOCOL_MISSING", context.paths.protocol,
    "protocol is not initialized"));
  if (protectedProtocol !== null) issues.push(protectedProtocol);
  issues.push(...mutexIssues(report.locks, issue).filter(item =>
    !(input.doctorMutexHeld && item.code === "DOCTOR_MUTEX_LIVE")));
  issues.push(...recoveryIssues(report.recovery, issue));
  for (const filePath of report.corrupt) if (filePath !== context.paths.protocol
    || (!protocolMissing && protectedProtocol === null)) issues.push(issue("CORRUPT_JSON", filePath,
    "invalid or inconsistent protocol record"));
  for (const item of report.messages.acknowledgements) if (item.location === "inbox")
    issues.push(issue("ACKED_MESSAGE_NOT_ARCHIVED",
      context.paths.inboxFile(item.message.to, item.message.id),
      "acknowledged message remains in inbox"));
  const required = [...new Set(input.requireLive ?? [])].sort();
  for (const agentId of required) {
    if (report.agents.live.some(agent => agent.agent_id === agentId)) continue;
    const stale = report.agents.stale.some(agent => agent.agent_id === agentId);
    issues.push(issue(stale ? "REQUIRED_AGENT_STALE" : "REQUIRED_AGENT_OFFLINE",
      context.paths.presenceFile(agentId), `required agent ${agentId} is not live`));
  }
  const lockDir = path.join(context.paths.locks, "claims.lock");
  const lockOwner = path.join(lockDir, "owner.json");
  if (await exists(lockDir) && !await exists(lockOwner)) issues.push(issue(
    "CLAIM_LOCK_OWNER_MISSING", lockDir, "claim lock has no owner record"));
  else if (await exists(lockOwner)) {
    const owner = await safeRead(context, lockOwner, validateLock, { corrupt: [] });
    if (owner !== null && context.now().getTime() - Date.parse(owner.acquired_at) > 60_000
      && !context.pidIsAlive(owner.pid)) issues.push(issue("STALE_CLAIM_LOCK", lockOwner,
      "claim lock owner is dead and older than sixty seconds", "warning"));
  }
  for (const agentId of await watcherIds(context)) {
    try {
      const inspected = await inspectWatcherOwnership(context, agentId);
      if (inspected?.repairable) issues.push(issue("STALE_WATCHER_OWNER",
        path.join(context.paths.locks, `watcher-${agentId}.json`),
        "watcher owner is dead and older than sixty seconds", "warning"));
    } catch {}
  }
  return issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}
async function performRepairs(context, issues) {
  const repairs = [];
  const corruptProtocol = issues.find(item => item.code === "CORRUPT_JSON"
    && item.path === context.paths.protocol);
  if (corruptProtocol !== undefined) {
    const repaired = await quarantineCorrupt(context, corruptProtocol.path);
    return repaired === null ? repairs : [repaired];
  }
  for (const item of issues.filter(entry => entry.code === "CORRUPT_JSON")) {
    const repaired = await quarantineCorrupt(context, item.path);
    if (repaired !== null) repairs.push(repaired);
  }
  let refreshed = await collectStatus(context);
  repairs.push(...await repairStaleWatcherMutexes(context, refreshed.locks));
  refreshed = await collectStatus(context);
  for (const item of refreshed.messages.acknowledgements) {
    if (item.location !== "inbox") continue;
    const repaired = await archiveAcknowledged(context, item.message);
    if (repaired !== null) repairs.push(repaired);
  }
  if (issues.some(item => item.code === "STALE_CLAIM_LOCK")
    && await repairStaleClaimLock(context)) repairs.push({
    action: "repair_stale_claim_lock", path: path.join(context.paths.locks, "claims.lock") });
  repairs.push(...await repairPendingForceReleases(context));
  for (const agentId of await watcherIds(context)) if (
    await repairStaleWatcherOwnership(context, agentId)) repairs.push({
    action: "repair_stale_watcher_owner",
    path: path.join(context.paths.locks, `watcher-${agentId}.json`),
  });
  return repairs;
}
export async function runDoctor(context, input = {}) {
  let report = await collectStatus(context);
  let issues = await operationalIssues(context, report, input);
  const incompatible = issues.some(item => ["PROTOCOL_MISSING", "UNKNOWN_PROTOCOL_VERSION",
    "UNKNOWN_SCHEMA_VERSION"]
    .includes(item.code));
  const corruptAudit = report.corrupt.some(filePath => isRecoveryArtifactPath(context, filePath));
  let repairs = [];
  if (input.repair && !incompatible && !corruptAudit) {
    if (report.locks.doctor?.state === "stale"
      && await repairStaleRepairMutex(context, "doctor")) repairs.push({
      action: "repair_stale_doctor_mutex", path: report.locks.doctor.path });
    if (!["young", "corrupt"].includes(report.locks.doctor?.state)) repairs =
      repairs.concat(await withRepairMutex(context, "doctor", null, async () => {
        const lockedReport = await collectStatus(context);
        const lockedIssues = await operationalIssues(context, lockedReport,
          { ...input, doctorMutexHeld: true });
        const lockedIncompatible = lockedIssues.some(item => ["PROTOCOL_MISSING",
          "UNKNOWN_PROTOCOL_VERSION", "UNKNOWN_SCHEMA_VERSION"].includes(item.code));
        const lockedCorruptAudit = lockedReport.corrupt.some(filePath =>
          isRecoveryArtifactPath(context, filePath));
        return lockedIncompatible || lockedCorruptAudit ? []
          : performRepairs(context, lockedIssues);
      }));
  }
  if (input.repair) { report = await collectStatus(context);
    issues = await operationalIssues(context, report, input); }
  return { ok: issues.length === 0, issues, repairs };
}
export function enforcementExit(report, options = {}) {
  if (report.corrupt.length > 0 || report.locks.doctor?.state === "corrupt"
    || report.locks.watcher.corrupt.length > 0) return EXIT.DATA;
  if (options.failOnStale && report.agents.stale.length > 0) return EXIT.REQUIRED;
  if (options.failOnPending && report.messages.required_unacked.length > 0) return EXIT.REQUIRED;
  return EXIT.OK;
}
