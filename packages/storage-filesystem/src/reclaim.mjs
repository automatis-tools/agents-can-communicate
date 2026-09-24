import path from "node:path";

import { readActiveJournal } from "./active-journal.mjs";
import { listDirectoryEntries, readJsonIfPresent } from "./atomic-json.mjs";
import { condemn, detachDoomed, discard, discardLeftovers, expired } from "./doomed-directory.mjs";
import { statePath } from "./record-id.mjs";

// Shared with the stage sweep that calls this, so one pass cannot spend two
// budgets. Exported for the caller that wants to reclaim without a bound.
export const RECLAIM_BUDGET = 512;

const jsonNames = async (directory, root) =>
  (await listDirectoryEntries(directory, { root }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => entry.name);

/**
 * Which transaction the store is in the middle of, or null when it cannot tell.
 *
 * `readActiveJournal` throws on a store with no authority record. Not knowing
 * which entry is active is not a licence to guess, so that answer suppresses
 * journal reclamation rather than failing the store open it runs inside.
 *
 * It suppresses it without holding the pass open. A store missing its authority
 * is one `openFilesystemStore` would have initialised, so it is broken rather
 * than busy, and doctor is what reports a broken store. Reporting work as
 * remaining would re-run this pass on every open forever, to keep finding the
 * same answer about files that are inert either way.
 */
async function activeTransaction(paths, root) {
  try {
    const active = await readActiveJournal(paths, root);
    return { known: true, transactionId: active.state === "open" ? active.transactionId : null };
  } catch {
    return { known: false, transactionId: null };
  }
}

/**
 * Condemn every journal entry that has been retired, with its completion marker.
 *
 * `retireJournalEntry` calls `retainFile`, which by construction never unlinks,
 * so a completed entry was kept forever; `completeJournal` then wrote a marker
 * that nothing reads. Both halves go together: a marker outliving its entry
 * records the completion of a file nothing can find.
 *
 * The marker directory is listed once rather than read per entry. A workspace
 * in daily use reaches thousands of retired transactions, and one open each
 * would be the cost this pass exists to remove.
 */
async function condemnRetiredJournals(paths, root, doomed, budget, deadlineAt) {
  let spent = 0;
  const active = await activeTransaction(paths, root);
  if (!active.known) return { spent, drained: true };

  const markerDirectory = path.join(paths.retained, "journal");
  const completed = new Set(await jsonNames(markerDirectory, root));
  for (const name of await jsonNames(paths.journal, root)) {
    if (spent + 2 > budget || expired(deadlineAt)) return { spent, drained: false };
    if (!completed.has(name)) continue;
    // The marker is written before the pointer goes idle, so a crash between
    // the two leaves a completed marker on the entry recovery still owns.
    if (path.basename(name, ".json") === active.transactionId) continue;
    await condemn(path.join(paths.journal, name), doomed);
    await condemn(path.join(markerDirectory, name), doomed);
    spent += 2;
  }
  return { spent, drained: true };
}

// Ordered as numbers, not as strings: a sequence can outgrow its padding, which
// is the same reason latestEphemeralMarker sorts this way. A name that is not a
// sequence is left alone rather than guessed at.
function supersededNames(names) {
  const sequenced = names.map(name => {
    const digits = path.basename(name, ".json");
    return /^\d+$/.test(digits) ? { name, order: BigInt(digits) } : null;
  }).filter(Boolean).sort((left, right) => (left.order < right.order ? 1 : -1));
  return sequenced.slice(1).map(entry => entry.name);
}

/**
 * Condemn every ephemeral retention marker except the newest of each record.
 *
 * `latestEphemeralMarker` reads only the newest and lists the rest to find it,
 * so an older marker is pure listing cost on a path that runs inside hooks.
 */
async function condemnSupersededMarkers(paths, root, doomed, budget, deadlineAt) {
  let spent = 0;
  const area = path.join(paths.retained, "ephemeral");
  for (const kind of await listDirectoryEntries(area, { root })) {
    if (!kind.isDirectory()) continue;
    const kindDirectory = path.join(area, kind.name);
    for (const record of await listDirectoryEntries(kindDirectory, { root })) {
      if (!record.isDirectory()) continue;
      const directory = path.join(kindDirectory, record.name);
      for (const name of supersededNames(await jsonNames(directory, root))) {
        if (spent >= budget || expired(deadlineAt)) return { spent, drained: false };
        await condemn(path.join(directory, name), doomed);
        spent += 1;
      }
    }
  }
  return { spent, drained: true };
}

/**
 * Reclaim what the store keeps and no longer reads.
 *
 * Both classes are provably unread - a retired journal entry has no reader at
 * all, and a superseded ephemeral marker is skipped by the only function that
 * looks - which is what lets this run without an operator asking. Anything that
 * carries meaning waits for `acc prune`.
 *
 * @returns {Promise<{ reclaimed: number, remaining: boolean }>}
 */
export async function reclaimRetired(paths,
  { root, limit = RECLAIM_BUDGET, deadlineAt } = {}) {
  if (expired(deadlineAt)) return { reclaimed: 0, remaining: true };
  let spent = 0;

  const leftovers = await discardLeftovers(root, limit, deadlineAt);
  spent += leftovers.spent;
  // What a previous pass already moved has left its live name; removing it is
  // what reclaims it, so it counts here exactly as this pass's own work does.
  let reclaimed = leftovers.spent;
  if (!leftovers.drained) return { reclaimed, remaining: true };

  const doomed = await detachDoomed(root);
  const journals = await condemnRetiredJournals(paths, root, doomed, limit - spent, deadlineAt);
  spent += journals.spent;
  const markers = journals.drained
    ? await condemnSupersededMarkers(paths, root, doomed, limit - spent, deadlineAt)
    : { spent: 0, drained: false };
  spent += markers.spent;

  const removed = await discard(doomed, root, limit - spent, deadlineAt);
  reclaimed += removed.spent;
  return { reclaimed,
    remaining: !journals.drained || !markers.drained || !removed.drained };
}

/**
 * Reclaim named state records, each with every retention marker it owns.
 *
 * `tx.remove` is the wrong instrument here and the difference matters. It
 * publishes a deletion marker, which hides the record and *adds* a file, and
 * `listState` then reads the record before asking whether that marker exists.
 * Removing records that way would make the store larger and its listings
 * slower, which is the opposite of what an operator ran this for. A marker only
 * exists because the store cannot unlink a live name; when the record itself
 * can be moved out, the marker has nothing left to say.
 *
 * `generation` is the caller's optimistic lock. Eligibility is decided from a
 * snapshot and applied later, and a claim can be renewed in between, which
 * writes a new generation onto the same id. A record that no longer matches is
 * skipped rather than removed: it is no longer the record that was judged.
 *
 * @param {{kind: string, id: string, generation: string}[]} entries
 * @returns {Promise<{ reclaimed: number, skipped: number, remaining: boolean }>}
 */
export async function reclaimStateRecords(paths, entries,
  { root, limit = RECLAIM_BUDGET, deadlineAt } = {}) {
  if (expired(deadlineAt)) return { reclaimed: 0, skipped: 0, remaining: entries.length > 0 };
  let spent = 0;
  let skipped = 0;

  const leftovers = await discardLeftovers(root, limit, deadlineAt);
  spent += leftovers.spent;
  if (!leftovers.drained) {
    return { reclaimed: leftovers.spent, skipped, remaining: true };
  }

  const doomed = await detachDoomed(root);
  let condemned = 0;
  let drained = true;
  for (const entry of entries) {
    // Two condemnations per record, asked for together, so a budget never
    // leaves a record half removed - its markers gone and the record itself
    // still listed, which would read as a live record whose deletion history
    // had been erased.
    if (spent + 2 > limit || expired(deadlineAt)) {
      drained = false;
      break;
    }
    const filePath = statePath(paths, entry.kind, entry.id);
    const found = await readJsonIfPresent(filePath, root).catch(() => null);
    if (found === null || found.value?.generation !== entry.generation) {
      skipped += 1;
      continue;
    }
    await condemn(filePath, doomed);
    await condemn(path.join(paths.retained, "state", entry.kind, entry.id), doomed)
      .catch(error => {
        // A record whose generation was never superseded owns no marker
        // directory. Nothing to move is the ordinary case, not a fault.
        if (error.code !== "ENOENT") throw error;
      });
    spent += 2;
    condemned += 2;
  }

  const removed = await discard(doomed, root, limit - spent, deadlineAt);
  return { reclaimed: leftovers.spent + removed.spent, skipped,
    remaining: !drained || !removed.drained || removed.spent < condemned };
}
