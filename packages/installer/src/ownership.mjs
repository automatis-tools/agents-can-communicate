import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

const SCHEMA_VERSION = 1;

// Installation state belongs to the machine, never to a project. A repository
// carrying it would hand one machine's paths to every clone, where none of them
// exist and all of them look like something to clean up.
const recordPath = dataHome => path.join(dataHome, "acc", "installs.json");

/**
 * Content fingerprint, or null when the file is gone.
 *
 * Uninstall compares this against what is on disk, so ACC removes what it wrote
 * and leaves what someone has since made their own. Deleting by name alone
 * throws away other people's work on the strength of a path it recognises.
 */
export async function fingerprint(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null;
    throw error;
  }
}

/**
 * Fingerprint of a whole directory ACC created.
 *
 * Every file's path and contents, in sorted order, so an edit anywhere inside a
 * plugin bundle is as visible as an edit to a single file. Sorting is what makes
 * it reproducible: directory order is a filesystem detail, and a hash that
 * depended on it would report a modification after a harmless copy.
 */
export async function treeFingerprint(root) {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ENOTDIR") return fingerprint(root);
    throw error;
  }
  const files = entries.filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative).update("\0");
    hash.update(await fingerprint(path.join(root, relative)) ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

const fingerprintFor = (artifact) => (artifact.kind === "tree"
  ? treeFingerprint(artifact.path)
  : fingerprint(artifact.path));

export async function loadOwnership({ dataHome }) {
  const file = recordPath(dataHome);
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, installs: [] };
    throw error;
  }
  let record;
  try {
    record = JSON.parse(source);
  } catch (error) {
    // Treating a corrupt record as empty would make the next uninstall a no-op
    // and orphan every file ACC has ever written on this machine.
    throw new AccError(EXIT.DATA, "the installation record is not valid JSON",
      { file, cause: error.message });
  }
  if (record?.schemaVersion !== SCHEMA_VERSION) {
    throw new AccError(EXIT.DATA, "unknown installation record schemaVersion",
      { file, schemaVersion: record?.schemaVersion ?? null });
  }
  return { schemaVersion: SCHEMA_VERSION, installs: record.installs ?? [] };
}

async function saveOwnership({ dataHome, record }) {
  const file = recordPath(dataHome);
  await mkdir(path.dirname(file), { recursive: true });
  // Published by rename so a crash mid-write leaves the previous record intact
  // rather than a truncated one that would fail to load at all.
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/**
 * Record what an install wrote, replacing any previous record for that adapter.
 *
 * Replacing rather than appending is what makes a re-run after a crash safe: the
 * second run's record describes what is actually on disk now, and an accumulated
 * one would list artifacts from a layout that no longer exists.
 */
export async function recordInstall({ dataHome, adapterId, version, artifacts }) {
  const stamped = await Promise.all(artifacts.map(async artifact => ({
    path: artifact.path,
    kind: artifact.kind ?? "file",
    // A merge artifact is a file ACC edited but does not own, so its bytes are
    // expected to change and hashing them would only ever produce a false alarm.
    sha256: artifact.kind === "merge" ? null : await fingerprintFor(artifact),
  })));
  const record = await loadOwnership({ dataHome });
  await saveOwnership({ dataHome, record: { schemaVersion: SCHEMA_VERSION,
    installs: [...record.installs.filter(install => install.adapterId !== adapterId),
      { adapterId, version, artifacts: stamped }] } });
}

const installFor = (record, adapterId) =>
  record.installs.find(install => install.adapterId === adapterId) ?? null;

/** Compare what was written against what is there now. Read-only. */
export async function verifyOwned({ dataHome, adapterId }) {
  const install = installFor(await loadOwnership({ dataHome }), adapterId);
  const result = { adapterId, present: install !== null, modified: [], missing: [],
    intact: [], delegated: [] };
  for (const artifact of install?.artifacts ?? []) {
    if (artifact.kind === "merge") { result.delegated.push(artifact.path); continue; }
    const current = await fingerprintFor(artifact);
    if (current === null) result.missing.push(artifact.path);
    else if (current !== artifact.sha256) result.modified.push(artifact.path);
    else result.intact.push(artifact.path);
  }
  return result;
}

/**
 * Remove the files this adapter's install wrote, and only those.
 *
 * A modified file is kept and reported. A merge artifact is never deleted at
 * all: the user owns that file and ACC owns some entries inside it, which is the
 * adapter's own uninstall to unpick because it knows the format.
 */
export async function removeOwned({ dataHome, adapterId }) {
  const record = await loadOwnership({ dataHome });
  const install = installFor(record, adapterId);
  const result = { adapterId, removed: [], kept: [], missing: [], delegated: [] };
  if (install === null) return result;

  for (const artifact of install.artifacts) {
    if (artifact.kind === "merge") { result.delegated.push(artifact.path); continue; }
    const current = await fingerprintFor(artifact);
    if (current === null) { result.missing.push(artifact.path); continue; }
    if (current !== artifact.sha256) { result.kept.push(artifact.path); continue; }
    await rm(artifact.path, { force: true, recursive: artifact.kind === "tree" });
    result.removed.push(artifact.path);
  }

  await saveOwnership({ dataHome, record: { schemaVersion: SCHEMA_VERSION,
    installs: record.installs.filter(entry => entry.adapterId !== adapterId) } });
  return result;
}
