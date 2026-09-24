import { randomUUID } from "node:crypto";
import { open, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { listDirectoryEntries } from "./atomic-json.mjs";
import { assertManagedDirectory, ensureManagedDirectory } from "./safe-directory.mjs";

// The store never unlinks a live name: Node exposes unlink only by pathname, so
// a checked parent can be replaced between the check and the call. What it does
// instead is move a doomed entry into a directory this process named with a
// value no other process knows, and then remove that directory whole. Every
// reclaimer in the store shares the primitive, so the rule is stated once.
//
// The prefix still reads "stage" because a store written by 0.6.3 leaves
// directories under this exact name when a pass is interrupted, and the resume
// below finds them by prefix. Renaming it would orphan them.
const DOOMED = "stage.sweeping-";

// Not assertPublicationDeadline: that one throws, and a maintenance pass on the
// path that opens the store must stop rather than fail the open. What is left
// is reported as remaining, and the next pass adopts it.
export const expired = deadlineAt => deadlineAt !== undefined && Date.now() >= deadlineAt;

export async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function doomedDirectories(root) {
  return (await listDirectoryEntries(root, { root }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(DOOMED))
    .map(entry => path.join(root, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export function doomedName(root) {
  return path.join(root, `${DOOMED}${randomUUID()}`);
}

export async function detachDoomed(root) {
  const directory = doomedName(root);
  await ensureManagedDirectory(root, directory);
  return directory;
}

/**
 * Move one doomed entry out of the store's live names.
 *
 * The destination name is unique because the sources are not: two records of
 * one kind each keep a marker named for its own sequence, and a journal entry
 * and a stage file can collide on nothing at all. The doomed directory is
 * discarded whole, so the names inside it carry no meaning.
 */
export async function condemn(filePath, doomed) {
  await rename(filePath, path.join(doomed, `${randomUUID()}.doomed`));
}

/**
 * Remove a doomed directory, one entry at a time, within a budget.
 *
 * @returns {Promise<{ spent: number, drained: boolean }>}
 */
export async function discard(directory, root, budget, deadlineAt) {
  let spent = 0;
  await assertManagedDirectory(root, directory);
  for (const entry of await listDirectoryEntries(directory, { root })) {
    if (spent >= budget || expired(deadlineAt)) return { spent, drained: false };
    await rm(path.join(directory, entry.name), { recursive: true, force: true });
    spent += 1;
  }
  await rmdir(directory).catch(error => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
  return { spent, drained: true };
}

/**
 * Finish what an interrupted pass left behind, within a budget.
 *
 * Every pass runs this first, and for a second reason: a pass that stops here
 * never detaches a further directory, so an exhausted budget cannot make them
 * accumulate.
 *
 * @returns {Promise<{ spent: number, drained: boolean }>}
 */
export async function discardLeftovers(root, budget, deadlineAt) {
  let spent = 0;
  for (const directory of await doomedDirectories(root)) {
    const removed = await discard(directory, root, budget - spent, deadlineAt);
    spent += removed.spent;
    if (!removed.drained) return { spent, drained: false };
  }
  return { spent, drained: true };
}
