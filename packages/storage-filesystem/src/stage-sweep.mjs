import { rename } from "node:fs/promises";
import path from "node:path";

import { EXIT } from "@agents-can-communicate/protocol";

import { encode, listDirectoryEntries, publishAtomic, readJsonIfPresent } from "./atomic-json.mjs";
import { discard, discardLeftovers, doomedName, expired, syncDirectory }
  from "./doomed-directory.mjs";
import { reclaimRetired } from "./reclaim.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";

// One pass never touches more than this many entries, counting both the legacy
// entries it moves and the entries it discards. A store left unopened can hold
// as many accepted stages as an unswept tmp/ did - tens of thousands - and an
// unbounded removal inside a hook is the budget failure this exists to avoid.
export const SWEEP_BUDGET = 512;

// A day between passes. A count-based threshold costs either a full listing of
// the directory this keeps small, or an fsync'ed write on every transaction. A
// timestamp costs one read.
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// An older ACC keeps renaming accepted stages onto tmp, because it does not
// know stage exists, so this is a standing rule rather than a one-off
// migration. They are moved rather than unlinked: joining the doomed directory
// costs one rename and keeps the no-unlink rule intact. A partial from a failed
// publication does not end in .published and never moves.
async function reclaimLegacy(paths, root, detached, budget, deadlineAt) {
  let spent = 0;
  for (const entry of await listDirectoryEntries(paths.tmp, { root })) {
    if (spent >= budget || expired(deadlineAt)) return { spent, drained: false };
    if (!entry.isFile() || !entry.name.endsWith(".published")) continue;
    await rename(path.join(paths.tmp, entry.name), path.join(detached, entry.name));
    spent += 1;
  }
  return { spent, drained: true };
}

/**
 * Empty the store's accepted staging directory.
 *
 * `spent` is what the budget bought, which the caller needs to give whatever
 * runs next the part of the budget this pass did not use.
 *
 * @returns {Promise<{ swept: number, remaining: boolean, spent: number }>}
 */
export async function sweepAcceptedStages(paths,
  { root, limit = SWEEP_BUDGET, deadlineAt } = {}) {
  // Two counters, because they answer different questions. `spent` is what the
  // budget bought: moving a legacy entry and removing one both cost a syscall
  // on the same directory. `swept` is what left the store, and a legacy entry
  // that was only moved has not left it yet. Counting a move as a sweep would
  // report two reclaimed records where one record was reclaimed.
  let spent = 0;
  let swept = 0;
  let remaining = false;

  // Finish what an interrupted pass left before starting another one. This runs
  // first for a second reason: a pass that stops here never detaches a further
  // directory, so an exhausted budget cannot make them accumulate.
  const leftovers = await discardLeftovers(root, limit, deadlineAt);
  spent += leftovers.spent;
  swept += leftovers.spent;
  if (!leftovers.drained) return { swept, remaining: true, spent };

  const detached = doomedName(root);
  // A store written by an older version has no stage directory at all, because
  // nothing ever published into one. Creating it before the detach makes that
  // the ordinary case rather than an error, and such a store is exactly the one
  // whose accepted stages are all still in tmp for the reclamation below.
  await ensureManagedDirectory(root, paths.stage);
  await rename(paths.stage, detached);
  await ensureManagedDirectory(root, paths.stage);
  await syncDirectory(root);

  const reclaimed = await reclaimLegacy(paths, root, detached, limit - spent, deadlineAt);
  spent += reclaimed.spent;
  if (!reclaimed.drained) return { swept, remaining: true, spent };

  const removed = await discard(detached, root, limit - spent, deadlineAt);
  spent += removed.spent;
  swept += removed.spent;
  if (!removed.drained) remaining = true;
  return { swept, remaining, spent };
}

const markerPath = paths => path.join(paths.locks, "stage-sweep.json");

// A lost lock and a lapsed budget are the same answer: not now, next open. They
// both arrive as CONFLICT, and neither is a reason to fail the caller.
async function withLockTolerantly(withLock, operation) {
  try {
    return await withLock(operation);
  } catch (error) {
    if (error?.code !== EXIT.CONFLICT) throw error;
    return { swept: 0, remaining: true };
  }
}

// An unreadable marker means the interval is unknown, and an unknown interval
// is treated as due: maintenance that refuses to run because its own bookkeeping
// is damaged is the failure it exists to prevent.
async function sweptAt(paths, root) {
  const found = await readJsonIfPresent(markerPath(paths), root).catch(() => null);
  const value = Date.parse(found?.value?.sweptAt ?? "");
  return Number.isNaN(value) ? null : value;
}

/**
 * Sweep only when the recorded pass is older than SWEEP_INTERVAL_MS.
 *
 * The due check is one read and it happens before the lock. Sweeping is a
 * write and needs the writer mutex, but taking that mutex is itself a mkdir, a
 * write, an fsync and a rename, and this runs on every store open - which means
 * inside every hook. Paying for the lock on the days there is nothing to sweep
 * would put that cost on every hook to do nothing, which is the shape of the
 * slowdown that made hooks time out in 0.6.1.
 *
 * `withLock` is the seam: production passes the writer mutex, tests count calls.
 *
 * @returns {Promise<{ swept: number, remaining: boolean }>}
 */
export async function sweepIfDue(paths,
  { root, clock, limit = SWEEP_BUDGET, deadlineAt, withLock = operation => operation() } = {}) {
  // Nothing below tolerates an expired budget: withWriterMutex refuses one, and
  // so does the publishAtomic that writes the marker. Leaving the work for the
  // next open is the whole point of a bounded pass, so leave before the first
  // call that would throw instead of failing the open this runs inside.
  if (expired(deadlineAt)) return { swept: 0, remaining: true };

  const now = Date.parse(clock.now());
  const last = await sweptAt(paths, root);
  if (last !== null && now - last < SWEEP_INTERVAL_MS) return { swept: 0, remaining: false };

  // The budget can lapse after the check above: the lock may be granted late,
  // or granted to someone else first. Both arrive as CONFLICT, from the mutex
  // or from the publishAtomic that writes the marker. Leaving that pass for the
  // next open is the bounded behaviour working, so it is answered here rather
  // than left for whoever called - maintenance never decides whether a store
  // can be opened. Every other fault is a real store problem and propagates.
  return withLockTolerantly(withLock, async () => {
    // Re-read under the lock: another process may have swept while this one
    // waited for it, and two sweeps in a row would detach an empty directory
    // for nothing.
    const holder = await sweptAt(paths, root);
    if (holder !== null && holder !== last && Date.parse(clock.now()) - holder < SWEEP_INTERVAL_MS) {
      return { swept: 0, remaining: false };
    }
    const stages = await sweepAcceptedStages(paths, { root, limit, deadlineAt });
    // One budget for the whole pass. The reclaimer gets what the stage sweep
    // did not spend, so opening a store never pays the bound twice, and a stage
    // sweep that ran out leaves the reclaimer for the next open rather than
    // borrowing against it.
    const retired = stages.remaining
      ? { reclaimed: 0, remaining: true }
      : await reclaimRetired(paths, { root, limit: limit - stages.spent, deadlineAt });
    const result = { swept: stages.swept + retired.reclaimed,
      remaining: stages.remaining || retired.remaining };
    // The marker records a *finished* pass, never an attempted one. A pass that
    // stopped at its entry budget or ran out of time leaves it unwritten, so
    // the next open carries on immediately. Recording an unfinished pass as
    // done would park the remainder for a whole interval: a store holding
    // 17,880 entries would drain over weeks rather than over a few opens.
    //
    // Writing it after an expired deadline would also throw, since
    // publishAtomic refuses one - out of the store open this runs inside.
    if (result.remaining || expired(deadlineAt)) {
      return { swept: result.swept, remaining: true };
    }
    await publishAtomic(markerPath(paths), encode({ sweptAt: clock.now() }),
      { root, tmpDir: paths.tmp, stageDir: paths.stage, replace: true, deadlineAt });
    return result;
  });
}
