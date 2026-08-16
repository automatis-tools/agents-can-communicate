import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { listJsonFiles, readJsonStrict, writeJsonAtomic } from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { readJsonRegularNoFollow, readRegularNoFollow } from "./safe-file.mjs";
import {
  validateAcknowledgement, validateHandoff, validateMessage, validateProtocol,
  validateSeenReceipt,
} from "./schema.mjs";

function inside(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function stem(filePath) { return path.basename(filePath, ".json"); }
function immutableDescriptor(context, filePath) {
  if (filePath === context.paths.protocol) return {
    validate: validateProtocol, bound: () => true };
  for (const root of [context.paths.inbox, context.paths.archive]) {
    if (inside(root, filePath)) return { validate: validateMessage, bound: record =>
      record.to === path.basename(path.dirname(filePath)) && record.id === stem(filePath) };
  }
  if (inside(context.paths.seen, filePath)) return { validate: validateSeenReceipt,
    bound: record => filePath === context.paths.seenFile(record.message_id, record.recipient) };
  if (inside(context.paths.acknowledgements, filePath)) return {
    validate: validateAcknowledgement, bound: record =>
      filePath === context.paths.ackFile(record.message_id, record.recipient) };
  if (inside(context.paths.handoffs, filePath)) return { validate: validateHandoff,
    bound: record => record.id === stem(filePath) };
  return null;
}
function bytesAreValid(context, filePath, bytes) {
  const descriptor = immutableDescriptor(context, filePath);
  if (descriptor === null) return null;
  try {
    const record = descriptor.validate(JSON.parse(bytes.toString("utf8")));
    return descriptor.bound(record);
  } catch { return false; }
}
function sameGeneration(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function digestFor(sourcePath, bytes) {
  return createHash("sha256").update(sourcePath).update(bytes).digest("hex");
}
function auditPaths(context, sourcePath, bytes) {
  const digest = digestFor(sourcePath, bytes);
  return {
    digest,
    quarantinePath: path.join(context.paths.quarantine, `corrupt-${digest}.data`),
    auditPath: path.join(context.paths.quarantine, `doctor-audit-${digest}.json`),
  };
}
function validateDoctorAudit(value) {
  const keys = ["action", "quarantine_path", "recorded_at", "schema_version",
    "sha256", "source_path"];
  const timestamp = Date.parse(value?.recorded_at);
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== keys.join() || value.schema_version !== 1
    || value.action !== "quarantine_corrupt_json" || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== value.recorded_at
    || !/^[a-f0-9]{64}$/.test(value.sha256) || !path.isAbsolute(value.source_path)
    || !path.isAbsolute(value.quarantine_path)) {
    throw new CommsError("invalid doctor audit", EXIT.DATA);
  }
  return value;
}
async function publishAudit(context, sourcePath, bytes, paths) {
  const audit = validateDoctorAudit({ schema_version: 1,
    action: "quarantine_corrupt_json", source_path: sourcePath,
    quarantine_path: paths.quarantinePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    recorded_at: context.now().toISOString() });
  try {
    await writeJsonAtomic(paths.auditPath, audit,
      { tmpDir: context.paths.tmp, exclusive: true });
  } catch (error) {
    if (!(error instanceof CommsError) || error.exitCode !== EXIT.CONFLICT) throw error;
    const existing = await readJsonStrict(paths.auditPath, validateDoctorAudit,
      context.paths.root);
    if (!isDeepStrictEqual(existing, { ...audit, recorded_at: existing.recorded_at }))
      throw new CommsError("repair audit conflicts with snapshot", EXIT.DATA);
  }
}
async function unlinkIfPresent(filePath) {
  try { await unlink(filePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function scanDoctorAudits(context) {
  const corrupt = [];
  for (const auditPath of await listJsonFiles(context.paths.quarantine,
    { root: context.paths.root })) {
    if (!path.basename(auditPath).startsWith("doctor-audit-")) continue;
    try {
      const audit = await readJsonStrict(auditPath, validateDoctorAudit, context.paths.root);
      const match = /^doctor-audit-([a-f0-9]{64})\.json$/.exec(path.basename(auditPath));
      if (match === null || !inside(context.paths.root, audit.source_path)
        || immutableDescriptor(context, audit.source_path) === null) throw new Error("unsafe audit");
      const canonicalQuarantine = path.join(context.paths.quarantine,
        `corrupt-${match[1]}.data`);
      if (audit.quarantine_path !== canonicalQuarantine) throw new Error("unsafe quarantine path");
      const bytes = await readRegularNoFollow(canonicalQuarantine,
        context.paths.root, context.openImmutableRecord);
      const paths = auditPaths(context, audit.source_path, bytes);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (auditPath !== paths.auditPath || audit.quarantine_path !== paths.quarantinePath
        || audit.sha256 !== checksum) throw new Error("audit binding mismatch");
    } catch { corrupt.push(auditPath); }
  }
  return corrupt.sort();
}

export async function quarantineCorrupt(context, sourcePath) {
  if (immutableDescriptor(context, sourcePath) === null) return null;
  const token = (context.randomUUID ?? randomUUID)();
  const snapshot = path.join(context.paths.quarantine, `doctor-snapshot-${token}.data`);
  try {
    try { await (context.linkCorruptRecord ?? link)(sourcePath, snapshot); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const [bytes, sourceBytes, snapshotStat, sourceStat] = await Promise.all([
      readRegularNoFollow(snapshot, context.paths.root),
      readRegularNoFollow(sourcePath, context.paths.root),
      lstat(snapshot), lstat(sourcePath),
    ]);
    if (!sameGeneration(snapshotStat, sourceStat) || !bytes.equals(sourceBytes)) return null;
    if (bytesAreValid(context, sourcePath, bytes)) return null;
    const paths = auditPaths(context, sourcePath, bytes);
    try { await link(snapshot, paths.quarantinePath); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await readRegularNoFollow(paths.quarantinePath, context.paths.root)).equals(bytes)) {
        throw new CommsError("quarantine snapshot conflicts", EXIT.DATA);
      }
    }
    if (!(await readRegularNoFollow(paths.quarantinePath, context.paths.root)).equals(bytes)) {
      throw new CommsError("quarantine snapshot changed", EXIT.DATA);
    }
    await publishAudit(context, sourcePath, bytes, paths);
    const [currentBytes, currentStat] = await Promise.all([
      readRegularNoFollow(sourcePath, context.paths.root), lstat(sourcePath),
    ]);
    if (!sameGeneration(snapshotStat, currentStat) || !bytes.equals(currentBytes)) return null;
    await (context.unlinkCorruptRecord ?? unlink)(sourcePath);
    return { action: "quarantine_corrupt_json", path: sourcePath,
      quarantine_path: paths.quarantinePath, audit_path: paths.auditPath };
  } finally { await unlinkIfPresent(snapshot); }
}

export async function archiveAcknowledged(context, message) {
  const source = context.paths.inboxFile(message.to, message.id);
  const destination = context.paths.archiveFile(message.to, message.id);
  await mkdir(path.dirname(destination), { recursive: true });
  async function validateDestination() {
    let existing;
    try { existing = (await readJsonRegularNoFollow(destination, validateMessage,
      context.paths.root, context.openArchiveRecord)).record; }
    catch (error) {
      if (error.code === "ENOENT") throw new CommsError(
        "archive destination is missing after inbox disappeared", EXIT.DATA);
      if (error instanceof CommsError) throw error;
      throw new CommsError("archive destination is not a strict regular record", EXIT.DATA,
        { path: destination, cause: error.message });
    }
    if (!isDeepStrictEqual(existing, message)) throw new CommsError(
      "archive destination conflicts with missing inbox message", EXIT.DATA);
  }
  try { await (context.linkArchiveRecord ?? link)(source, destination); }
  catch (error) {
    if (error.code === "ENOENT") { await validateDestination(); return null; }
    if (error.code !== "EEXIST") throw error;
    let sourceBytes;
    try { sourceBytes = await readRegularNoFollow(source, context.paths.root); }
    catch (sourceError) {
      if (sourceError.code !== "ENOENT") throw sourceError;
      await validateDestination();
      return null;
    }
    const destinationBytes = await readRegularNoFollow(destination, context.paths.root);
    if (!sourceBytes.equals(destinationBytes)) {
      throw new CommsError("archive destination conflicts with inbox message", EXIT.DATA);
    }
  }
  await unlinkIfPresent(source);
  return { action: "archive_acknowledged_message", path: source, destination };
}
