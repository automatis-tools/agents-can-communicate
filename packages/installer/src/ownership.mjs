import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile }
  from "node:fs/promises";
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
/**
 * @param version the client's version, as detected. `accVersion` is ACC's own,
 * which is what tells a later run that the plugin in the client is older than
 * the code now running: updating the npm package replaces the CLI and the hook
 * runtime, and leaves the bundle inside the client exactly where it was.
 */
export async function recordInstall({ dataHome, adapterId, version, accVersion = null,
  artifacts, createdDirectories = [] }) {
  const stamped = await Promise.all(artifacts.map(async artifact => ({
    path: artifact.path,
    kind: artifact.kind ?? "file",
    // A merge artifact is a file ACC edited but does not own, so its bytes are
    // expected to change and hashing them would only ever produce a false alarm.
    sha256: artifact.kind === "merge" ? null : await fingerprintFor(artifact),
  })));
  const record = await loadOwnership({ dataHome });
  const previous = record.installs.find(install => install.adapterId === adapterId);
  const directories = [...new Set([
    ...(previous?.createdDirectories ?? []), ...createdDirectories,
  ])].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length
    || left.localeCompare(right));
  await saveOwnership({ dataHome, record: { schemaVersion: SCHEMA_VERSION,
    installs: [...record.installs.filter(install => install.adapterId !== adapterId),
      { adapterId, version, accVersion, artifacts: stamped,
        ...(directories.length === 0 ? {} : { createdDirectories: directories }) }] } });
}

const installFor = (record, adapterId) =>
  record.installs.find(install => install.adapterId === adapterId) ?? null;

const inside = (home, candidate) => {
  const relative = path.relative(home, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

async function hasSymlinkAncestor(home, candidate) {
  let current = candidate;
  while (inside(home, current)) {
    const stat = await lstat(current).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) return true;
    current = path.dirname(current);
  }
  return false;
}

/** Return planned artifact parents that do not yet exist under the client home. */
export async function missingArtifactParents({ home, artifacts }) {
  if (typeof home !== "string") return [];
  const root = path.resolve(home);
  const missing = new Set();
  for (const artifact of artifacts) {
    let directory = path.dirname(path.resolve(artifact.path));
    while (inside(root, directory)) {
      try {
        await lstat(directory);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        missing.add(directory);
        directory = path.dirname(directory);
      }
    }
  }
  return [...missing].sort((left, right) =>
    left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
}

/** Remove recorded parents deepest-first, but only while each remains an empty directory. */
export async function removeEmptyOwnedDirectories({ home, directories = [] }) {
  const result = { removed: [], kept: [], missing: [] };
  const root = typeof home === "string" ? path.resolve(home) : null;
  const ordered = [...new Set(directories)].sort((left, right) =>
    right.split(path.sep).length - left.split(path.sep).length || left.localeCompare(right));
  for (const directory of ordered) {
    if (root === null || !inside(root, path.resolve(directory))) {
      result.kept.push(directory);
      continue;
    }
    let stat;
    try {
      stat = await lstat(directory);
    } catch (error) {
      if (error.code === "ENOENT") { result.missing.push(directory); continue; }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || await hasSymlinkAncestor(root, path.dirname(directory))) {
      result.kept.push(directory);
      continue;
    }
    try {
      await rmdir(directory);
      result.removed.push(directory);
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST"].includes(error.code)) {
        result.kept.push(directory);
        continue;
      }
      if (error.code === "ENOENT") { result.missing.push(directory); continue; }
      throw error;
    }
  }
  return result;
}

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

/** Remove owned artifacts while retaining the record as retry authority. */
export async function removeOwnedArtifacts({ dataHome, adapterId }) {
  const record = await loadOwnership({ dataHome });
  const install = installFor(record, adapterId);
  const result = { adapterId, removed: [], kept: [], missing: [], delegated: [],
    createdDirectories: install?.createdDirectories ?? [] };
  if (install === null) return result;

  for (const artifact of install.artifacts) {
    if (artifact.kind === "merge") { result.delegated.push(artifact.path); continue; }
    const current = await fingerprintFor(artifact);
    if (current === null) { result.missing.push(artifact.path); continue; }
    if (current !== artifact.sha256) { result.kept.push(artifact.path); continue; }
    await rm(artifact.path, { force: true, recursive: artifact.kind === "tree" });
    result.removed.push(artifact.path);
  }

  return result;
}

/** Forget one install only after every adapter-owned cleanup step succeeded. */
export async function finalizeRemoval({ dataHome, adapterId }) {
  const record = await loadOwnership({ dataHome });
  if (installFor(record, adapterId) === null) return false;

  await saveOwnership({ dataHome, record: { schemaVersion: SCHEMA_VERSION,
    installs: record.installs.filter(entry => entry.adapterId !== adapterId) } });
  return true;
}

/** Remove and finalize for callers that perform no delegated adapter cleanup. */
export async function removeOwned(options) {
  const result = await removeOwnedArtifacts(options);
  await finalizeRemoval(options);
  return result;
}
