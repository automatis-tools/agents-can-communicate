import { randomUUID } from "node:crypto";
import { rmdir } from "node:fs/promises";
import path from "node:path";

import { listDirectoryEntries } from "./atomic-json.mjs";
import { removeTree, renameEntry } from "./portable-fs.mjs";
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
  await renameEntry(filePath, path.join(doomed, `${randomUUID()}.doomed`));
}

/**
 * Remove a doomed directory, one entry at a time, within a budget.
 *
 * A condemned entry can be a whole directory - contract 7's index cache after a migration,
 * a pruned cache - and the pass may run inside a store open, under the writer mutex. Such a
 * directory is emptied the same way, a file at a time, so its size is paid for in the
 * budget (review of #306: 20,000 cache pages went in one call, 3.1 s inside a hook).
 * `spent` is that budget; `removed` counts only the condemned entries themselves, which is
 * what left the store.
 *
 * @returns {Promise<{ spent: number, removed: number, drained: boolean }>}
 */
export async function discard(directory, root, budget, deadlineAt) {
  await assertManagedDirectory(root, directory);
  const emptied = await empty(directory, root, budget, deadlineAt);
  if (!emptied.drained) return emptied;
  await rmdir(directory).catch(error => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
  return emptied;
}

async function empty(directory, root, budget, deadlineAt) {
  let spent = 0, removed = 0;
  for (const entry of await listDirectoryEntries(directory, { root })) {
    if (spent >= budget || expired(deadlineAt)) return { spent, removed, drained: false };
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const inner = await empty(target, root, budget - spent, deadlineAt);
      spent += inner.spent;
      if (!inner.drained || spent >= budget) return { spent, removed, drained: false };
    }
    await removeTree(target);
    spent += 1; removed += 1;
  }
  return { spent, removed, drained: true };
}

/**
 * Finish what an interrupted pass left behind, within a budget.
 *
 * Every pass runs this first, and for a second reason: a pass that stops here
 * never detaches a further directory, so an exhausted budget cannot make them
 * accumulate.
 *
 * @returns {Promise<{ spent: number, removed: number, drained: boolean }>}
 */
export async function discardLeftovers(root, budget, deadlineAt) {
  let spent = 0, removed = 0;
  for (const directory of await doomedDirectories(root)) {
    const discarded = await discard(directory, root, budget - spent, deadlineAt);
    spent += discarded.spent; removed += discarded.removed;
    if (!discarded.drained) return { spent, removed, drained: false };
  }
  return { spent, removed, drained: true };
}
