import { createHash, randomUUID } from "node:crypto";
import { link, open, readdir } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { assertPublicationDeadline } from "./deadline.mjs";
import { isWindows, renameReplacing, syncEntry } from "./portable-fs.mjs";
import { assertManagedDirectory, ensureManagedDirectory } from "./safe-directory.mjs";
import { readRegularNoFollow } from "./safe-file.mjs";

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

function retainedStage(destination, root, stageDir) {
  const identity = createHash("sha256")
    .update(path.relative(root, destination))
    .digest("hex");
  return path.join(stageDir, `${identity}.published`);
}

const DURABILITY = new Set(["full", "bytes", "none"]);

/**
 * The durability of a publication that another flush follows.
 *
 * On Windows flushing a file commits NTFS's metadata journal up to that file's
 * last change, and that journal is one sequence: the next flush commits this
 * rename too, so only the bytes are flushed here. A crash before that flush
 * leaves the previous version, or nothing, and nothing written after it can be
 * durable without it (docs/design/2026-09-30-native-windows-support.md, "What
 * is flushed"). POSIX syncs the name's own directory.
 */
export const nameCommittedLater = platform => (isWindows(platform) ? "bytes" : "full");

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
 * `durability` is what a crash of the machine may cost the record, since every
 * flush waits for the whole disk - on windows-latest from 15 ms to 5.8 s:
 * - "full" (the default): nothing; its bytes are flushed before they take the
 *   name, and the name is flushed before this returns;
 * - "bytes": the name, so a reader finds the previous version and never torn
 *   bytes - for a record whose loss its owner recovers from;
 * - "none": everything - for a record whose reader treats damage as absence.
 *
 * @returns {Promise<"published" | "already_published">}
 */
export async function publishAtomic(destination, bytes,
  { root, tmpDir, stageDir, replace = false, durability = "full", deadlineAt, afterAccepted,
    afterStageEnsured, afterStageRenamed, sync = syncEntry }) {
  if (!DURABILITY.has(durability)) {
    throw new AccError(EXIT.USAGE, "unknown publication durability", { durability });
  }
  assertPublicationDeadline(deadlineAt);
  // The accepted stage lives apart from the partial a failed publication
  // leaves, so what a file is follows from the directory it was created in
  // rather than from how its name ends. Defaulted from the root the way
  // active-journal.mjs defaults tmpDir, so every caller keeps working.
  stageDir = stageDir ?? path.join(root, "stage");
  const destinationDir = path.dirname(destination);
  // Every check settles before a refusal is reported: Promise.all would reject
  // on the first one while the others still create directories under a root
  // the caller may already be removing.
  const prepared = await Promise.allSettled([
    ensureManagedDirectory(root, tmpDir),
    ensureManagedDirectory(root, stageDir),
    ensureManagedDirectory(root, destinationDir),
  ]);
  const refused = prepared.find(result => result.status === "rejected");
  if (refused) throw refused.reason;
  if (!replace) {
    const existing = await bytesIfPresent(destination, root);
    if (existing !== null) {
      if (existing.equals(bytes)) return "already_published";
      throw new AccError(EXIT.CONFLICT, "record already published with different bytes",
        { destination });
    }
  }

  const stage = retainedStage(destination, root, stageDir);
  // The temporary stays in tmpDir: until the bytes are accepted it is a
  // partial, and a partial is exactly what tmp holds.
  const temporary = path.join(tmpDir,
    `${path.basename(stage)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = await open(temporary, "wx");
  let stageAcceptedBytes = false;
  try {
    await handle.writeFile(bytes);
    if (durability !== "none") await handle.sync();
    if (replace) {
      await handle.close();
      handle = null;
      assertPublicationDeadline(deadlineAt);
      await renameReplacing(temporary, destination, { deadlineAt });
      // The bytes are at their name now: the write is decided and visible, and
      // its flush is bounded by its own wait, never by the caller's deadline,
      // which would report a published record as failed.
      if (durability === "full") await sync(destinationDir, destination);
      return "published";
    }

    try {
      assertPublicationDeadline(deadlineAt);
      await link(temporary, destination);
      stageAcceptedBytes = true;
      if (durability === "full") await sync(destinationDir, destination);
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
      // `ensure`, not `assert`: the sweep empties this directory by renaming it
      // aside and recreating it, and a publication that began before that swap
      // arrives here to find the name gone. Both apply the same managed-root
      // checks - the only difference is that this one recreates what the sweep
      // has already taken away, instead of failing a write whose bytes are
      // already published.
      // The seam the race test uses, in the manner retainFile already
      // establishes: the window this closes is invisible without one.
      await afterAccepted?.();
      await retainAcceptedStage({ root, stageDir, temporary, stage, afterStageEnsured,
        afterStageRenamed });
    } else {
      // A crash/error before immutable acceptance keeps its unique partial.
      // Retention avoids the unsafe parent-check/unlink pathname window, while
      // the deterministic accepted stage bounds all ordinary retries.
      await retainFile(temporary, { root });
    }
  }
}

// The sweep can take `stage` between any two of these steps: it renames the
// directory aside, and a store still opening publishes here without the writer
// mutex the sweep holds (CI on #217). The bytes are already published, so the
// retained copy goes to whichever directory carries the name when it moves. The
// copy is never flushed: it is never read, and the sweep discards it. A crash
// that loses its move leaves the temporary in tmp, which is what tmp holds. The
// two callbacks are seams for the race tests.
const STAGE_RETRIES = 4;

async function retainAcceptedStage({ root, stageDir, temporary, stage, afterStageEnsured,
  afterStageRenamed }) {
  for (let attempt = 0; ; attempt += 1) {
    await ensureManagedDirectory(root, stageDir);
    await afterStageEnsured?.();
    try {
      await renameReplacing(temporary, stage);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || attempt >= STAGE_RETRIES) throw error;
    }
  }
  await afterStageRenamed?.();
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
