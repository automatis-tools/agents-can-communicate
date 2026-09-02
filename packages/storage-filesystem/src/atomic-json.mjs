import { createHash, randomUUID } from "node:crypto";
import { link, open, readdir, rename } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { assertManagedDirectory, ensureManagedDirectory } from "./safe-directory.mjs";
import { readRegularNoFollow } from "./safe-file.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function encode(value) {
  const serialised = JSON.stringify(value, null, 2);
  if (serialised === undefined) {
    throw new AccError(EXIT.DATA, "record is not JSON serializable", { value: typeof value });
  }
  return Buffer.from(`${serialised}\n`, "utf8");
}

async function bytesIfPresent(filePath, root, openFile) {
  try {
    return await readRegularNoFollow(filePath, root, openFile);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function retainedStage(destination, root, tmpDir) {
  const identity = createHash("sha256")
    .update(path.relative(root, destination))
    .digest("hex");
  return path.join(tmpDir, `${identity}.published`);
}

async function replaceHandleBytes(handle, bytes) {
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    offset += bytesWritten;
  }
  await handle.sync();
}

/**
 * Publish bytes atomically.
 *
 * Two modes, and the distinction matters: immutable evidence - events, journal
 * entries, audits - is published by link(), so overwriting is impossible by
 * construction rather than by a check that could race, and re-publishing
 * identical bytes is idempotent while different bytes fail closed. Materialised
 * state is mutable by design, which is what generations exist for, so it is
 * published by rename(). Conflating the two makes every state update fail.
 *
 * @returns {Promise<"published" | "already_published">}
 */
export async function publishAtomic(destination, bytes, { root, tmpDir, replace = false }) {
  const destinationDir = path.dirname(destination);
  await Promise.all([
    ensureManagedDirectory(root, tmpDir),
    ensureManagedDirectory(root, destinationDir),
  ]);
  if (!replace) {
    const existing = await bytesIfPresent(destination, root);
    if (existing !== null) {
      if (existing.equals(bytes)) return "already_published";
      throw new AccError(EXIT.CONFLICT, "record already published with different bytes",
        { destination });
    }
  }

  const stage = retainedStage(destination, root, tmpDir);
  const temporary = `${stage}.${process.pid}.${randomUUID()}.tmp`;
  let handle = await open(temporary, "wx");
  let stageAcceptedBytes = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    if (replace) {
      await handle.close();
      handle = null;
      await rename(temporary, destination);
      await syncDirectory(destinationDir);
      return "published";
    }

    try {
      await link(temporary, destination);
      stageAcceptedBytes = true;
      await syncDirectory(destinationDir);
      return "published";
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await bytesIfPresent(destination, root);
      if (existing !== null && existing.equals(bytes)) {
        stageAcceptedBytes = true;
        return "already_published";
      }
      if (existing !== null) {
        // This caller lost a different-payload race. Keep no rejected bytes:
        // rewrite its still-open private inode with the accepted destination
        // before consolidating every contender onto one retained stage name.
        await replaceHandleBytes(handle, existing);
        stageAcceptedBytes = true;
      }
      throw new AccError(EXIT.CONFLICT, "record already published with different bytes",
        { destination });
    }
  } finally {
    await handle?.close();
    if (stageAcceptedBytes) {
      await assertManagedDirectory(root, tmpDir);
      await rename(temporary, stage);
      await syncDirectory(tmpDir);
    } else {
      // A crash/error before immutable acceptance keeps its unique partial.
      // Retention avoids the unsafe parent-check/unlink pathname window, while
      // the deterministic accepted stage bounds all ordinary retries.
      await retainFile(temporary, { root });
    }
  }
}

// The opener is the seam the race tests use, and stays last so callers that do
// not care never see it.
export async function readJsonIfPresent(filePath, root, openFile) {
  const bytes = await bytesIfPresent(filePath, root, openFile);
  if (bytes === null) return null;
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch (error) {
    // Named in the message, not only in the details: human mode prints the
    // message alone, and "invalid JSON record" sent a reader looking through a
    // whole workspace for a file the error already knew.
    throw new AccError(EXIT.DATA, `invalid JSON record: ${filePath}`,
      { filePath, cause: error.message });
  }
}

export async function listDirectoryEntries(dirPath, { root, readDirectory = readdir } = {}) {
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
  if (before.stat.dev !== after.stat.dev || before.stat.ino !== after.stat.ino) {
    throw new AccError(EXIT.DATA, "managed directory changed while listing", { dirPath, root });
  }
  return entries;
}

export async function listJsonFiles(dirPath, options) {
  return (await listDirectoryEntries(dirPath, options))
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

// Node exposes unlink only by pathname: directory handles cannot be passed to
// unlinkat, so checking a parent and then unlinking still lets an adversary
// replace that parent in between. Retention is the safe primitive. Callers
// publish an append-only logical marker after this validation and never unlink
// the retained path. The callback is the deterministic race seam.
export async function retainFile(filePath, { root, afterValidation } = {}) {
  await assertManagedDirectory(root, path.dirname(filePath));
  await afterValidation?.();
  return "retained";
}
