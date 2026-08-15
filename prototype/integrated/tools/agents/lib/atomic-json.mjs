import { randomUUID } from "node:crypto";
import {
  link,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { CommsError, EXIT } from "./errors.mjs";
import { assertManagedDirectory, ensureManagedDirectory } from "./safe-directory.mjs";
import { readJsonRegularNoFollow, readRegularNoFollow } from "./safe-file.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function readJsonStrict(filePath, validate, root, openFile) {
  return (await readJsonRegularNoFollow(filePath, validate, root, openFile)).record;
}

export async function writeJsonAtomic(
  filePath,
  value,
  { tmpDir, exclusive = false },
) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new CommsError("record is not JSON serializable", EXIT.DATA, { filePath });
  }
  const buffer = Buffer.from(`${serialized}\n`, "utf8");
  const destinationDir = path.dirname(filePath);
  const root = path.dirname(path.resolve(tmpDir));
  await Promise.all([
    ensureManagedDirectory(root, tmpDir),
    ensureManagedDirectory(root, destinationDir),
  ]);
  const temporaryPath = path.join(
    tmpDir,
    `${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlinkIfPresent(temporaryPath);
    throw error;
  }
  await handle.close();

  try {
    if (exclusive) {
      try {
        await link(temporaryPath, filePath);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new CommsError("immutable record already exists", EXIT.CONFLICT, {
            filePath,
          });
        }
        throw error;
      }
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, filePath);
    }
    await syncDirectory(destinationDir);
  } catch (error) {
    await unlinkIfPresent(temporaryPath);
    throw error;
  }
}

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function listDirectoryEntries(
  dirPath,
  { root, readDirectory = readdir } = {},
) {
  let before;
  try {
    before = await assertManagedDirectory(root, dirPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let entries;
  try {
    entries = await readDirectory(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const after = await assertManagedDirectory(root, dirPath);
  if (!sameDirectory(before.stat, after.stat)) {
    throw new CommsError("managed directory changed while listing", EXIT.DATA,
      { dirPath, root });
  }
  return entries;
}

export async function listJsonFiles(dirPath, options) {
  return (await listDirectoryEntries(dirPath, options))
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function moveFileAtomic(source, destination, { root } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new CommsError("atomic move requires an absolute managed root", EXIT.DATA, { root });
  }
  const sourceDir = path.dirname(source);
  const destinationDir = path.dirname(destination);
  await Promise.all([
    ensureManagedDirectory(root, sourceDir),
    ensureManagedDirectory(root, destinationDir),
  ]);
  await rename(source, destination);
  await Promise.all([...new Set([sourceDir, destinationDir])].map(syncDirectory));
}

async function bytesIfPresent(filePath, root) {
  try {
    return await readRegularNoFollow(filePath, root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function requireEqualBytes(actual, expected, source, destination, name) {
  if (actual === null || !actual.equals(expected)) {
    throw new CommsError(`${name} conflicts with immutable message evidence`, EXIT.DATA, {
      source,
      destination,
    });
  }
}

export async function archiveFileNoReplace(
  source,
  destination,
  { root, expectedBytes },
) {
  const expected = Buffer.from(expectedBytes);
  const sourceDir = path.dirname(source);
  const destinationDir = path.dirname(destination);
  await Promise.all([
    ensureManagedDirectory(root, sourceDir),
    ensureManagedDirectory(root, destinationDir),
  ]);

  let linked = false;
  try {
    await link(source, destination);
    linked = true;
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
  }

  requireEqualBytes(await bytesIfPresent(destination, root), expected,
    source, destination, "archive destination");
  const sourceBytes = await bytesIfPresent(source, root);
  if (sourceBytes !== null) {
    requireEqualBytes(sourceBytes, expected, source, destination, "inbox source");
    try {
      await unlink(source);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await Promise.all([...new Set([sourceDir, destinationDir])].map(syncDirectory));
  return { linked, sourceRemoved: sourceBytes !== null };
}
