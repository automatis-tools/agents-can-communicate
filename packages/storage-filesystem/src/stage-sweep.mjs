import { randomUUID } from "node:crypto";
import { open, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { listDirectoryEntries } from "./atomic-json.mjs";
import { assertManagedDirectory, ensureManagedDirectory } from "./safe-directory.mjs";

// One pass never touches more than this many entries, counting both the legacy
// entries it moves and the entries it discards. A store left unopened can hold
// as many accepted stages as an unswept tmp/ did - tens of thousands - and an
// unbounded removal inside a hook is the budget failure this exists to avoid.
export const SWEEP_BUDGET = 512;

const DETACHED = "stage.sweeping-";

// Not assertPublicationDeadline: that one throws, and a maintenance pass on the
// path that opens the store must stop rather than fail the open. What is left
// is reported as remaining, and the next pass adopts it.
const expired = deadlineAt => deadlineAt !== undefined && Date.now() >= deadlineAt;

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function detachedDirectories(root) {
  return (await listDirectoryEntries(root, { root }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(DETACHED))
    .map(entry => path.join(root, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

// Removal happens only in here: a directory this sweep named with a value no
// other process knows, and detached from the name a publisher resolves before a
// single entry was touched. That is the ground releaseCanonical stands on in
// writer-mutex.mjs, not the check-then-unlink window atomic-json.mjs refuses.
async function discard(directory, root, budget, deadlineAt) {
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
 * Empty the store's accepted staging directory.
 *
 * @returns {Promise<{ swept: number, remaining: boolean }>}
 */
export async function sweepAcceptedStages(paths,
  { root, limit = SWEEP_BUDGET, deadlineAt } = {}) {
  let swept = 0;
  let remaining = false;

  // Finish what an interrupted pass left before starting another one. This runs
  // first for a second reason: a pass that stops here never detaches a further
  // directory, so an exhausted budget cannot make them accumulate.
  for (const directory of await detachedDirectories(root)) {
    const { spent, drained } = await discard(directory, root, limit - swept, deadlineAt);
    swept += spent;
    if (!drained) return { swept, remaining: true };
  }

  const detached = path.join(root, `${DETACHED}${randomUUID()}`);
  await assertManagedDirectory(root, paths.stage);
  try {
    await rename(paths.stage, detached);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Nothing to detach: the store has not published into stage yet.
    await ensureManagedDirectory(root, paths.stage);
    return { swept, remaining };
  }
  await ensureManagedDirectory(root, paths.stage);
  await syncDirectory(root);

  const { spent, drained } = await discard(detached, root, limit - swept, deadlineAt);
  swept += spent;
  if (!drained) remaining = true;
  return { swept, remaining };
}
