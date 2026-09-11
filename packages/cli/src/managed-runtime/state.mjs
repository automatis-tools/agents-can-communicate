import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Resolve existing ancestors without creating an uninitialized manager. */
export async function canonicalManagerRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("manager root must be absolute");
  let current = path.resolve(root);
  const tail = [];
  for (;;) {
    try { return path.join(await realpath(current), ...tail); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function managedDirectory(directory, { create = false } = {}) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("managed directory is not a regular directory");
    if (create) {
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.chmod(0o700); } finally { await handle.close(); }
    }
    return true;
  } catch (error) {
    if (!create && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Internal callers validate every managed parent before opening a record. */
export async function readManagedJson(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error("managed record must be a regular file");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

export async function writeManagedJson(file, value) {
  const temporary = path.join(path.dirname(file), `.record-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

const nonempty = value => typeof value === "string" && value.length > 0;
const nullableString = value => value === null || nonempty(value);

export async function validateRuntime(root, runtime) {
  if (!runtime || !nonempty(runtime.version) || typeof runtime.root !== "string"
    || !path.isAbsolute(runtime.root)) throw new Error("invalid control generation");
  // Absent means a pointer written before the contract field existed. Present
  // but malformed is a corrupt record, and reading it as unknown would let an
  // incompatible generation past the gate.
  if (runtime.storeVersion !== undefined && runtime.storeVersion !== null
    && (!Number.isSafeInteger(runtime.storeVersion) || runtime.storeVersion <= 0)) {
    throw new Error("invalid control generation");
  }
  const generations = path.join(root, "generations");
  const resolved = await canonicalManagerRoot(runtime.root);
  const relative = path.relative(generations, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("control runtime must be inside manager generations");
  }
  // An internal symlink can redirect all generations outside the manager even
  // when a lexical pointer appears contained.
  if (await managedDirectory(generations)) {
    if (await realpath(generations) !== generations) throw new Error("invalid control generations directory");
  }
  return { version: runtime.version, root: resolved, storeVersion: runtime.storeVersion ?? null };
}

async function validateControl(root, value) {
  if (!value || value.schemaVersion !== 1 || !["ready", "activating"].includes(value.phase)
    || typeof value.auto !== "boolean" || !nullableString(value.pin)
    || value.autoPreference !== undefined && typeof value.autoPreference !== "boolean"
    || !nullableString(value.checkedAt) || !nullableString(value.notice)
    || !nonempty(value.home) || !path.isAbsolute(value.home)
    || !Array.isArray(value.targets) || !value.targets.every(nonempty)
    || !(value.pending === null || typeof value.pending === "object")) {
    throw new Error("invalid managed runtime control");
  }
  const active = await validateRuntime(root, value.active);
  const pending = value.pending === null ? null : await validateRuntime(root, value.pending);
  return { ...value, active, pending };
}

export async function readControl(root) {
  root = await canonicalManagerRoot(root);
  if (!await managedDirectory(root)) return null;
  const value = await readManagedJson(path.join(root, "control.json"));
  return value === undefined ? null : validateControl(root, value);
}

/** Caller holds withManagerLock for any read-modify-write transaction. */
export async function writeControl(root, value) {
  root = await canonicalManagerRoot(root);
  const validated = await validateControl(root, value);
  await managedDirectory(root, { create: true });
  await writeManagedJson(path.join(root, "control.json"), validated);
  return validated;
}
