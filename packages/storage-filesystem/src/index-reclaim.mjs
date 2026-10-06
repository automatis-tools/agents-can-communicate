import path from "node:path";
import { idleJournal, readActiveJournal } from "./active-journal.mjs";
import { listDirectoryEntries, nameCommittedLater } from "./atomic-json.mjs";
import { condemn, detachDoomed, discard, expired } from "./doomed-directory.mjs";
import { createIndexIO } from "./index-io.mjs";
import { IndexCacheUnavailable } from "./index-pages.mjs";
import { readReclaimProgress, writeReclaimProgress } from "./index-reclaim-progress.mjs";
import { readStoreIdentity } from "./identity.mjs";
import { journalEntry, writeJournalEntry } from "./journal.mjs";
import { syncPruneDirectories } from "./prune-durability.mjs";
import { assertManagedDirectory } from "./safe-directory.mjs";

const children = page => page.type === "branch" ? page.children.map(([, hash]) => hash)
  : page.type === "leaf" ? [...page.entries.map(entry => entry.ids), page.next].filter(Boolean)
    : [page.next].filter(Boolean);

// The caller holds the writer mutex. Persist both mark and sweep progress: a
// live graph or a directory larger than one pass must eventually finish. Roots
// added by intervening writers are marked before sweeping resumes. Previously
// marked roots stay in the conservative live superset until the next cycle.
export async function reclaimIndexPages(paths, { root, roots, limit = 512, deadlineAt } = {}) {
  let spent = 0, reclaimed = 0;
  const result = (remaining, deferred = false) => ({ reclaimed, remaining, spent, deferred });
  if (expired(deadlineAt)) return result(true, true);
  const directory = path.join(root, "indexes", "v1", "pages");
  try { await assertManagedDirectory(root, directory); }
  catch (error) { return result(error.code !== "ENOENT", error.code !== "ENOENT"); }
  if (limit < 4) return result(true);
  const io = createIndexIO({ paths, root, publishOptions: {} });
  if (roots === undefined) {
    let manifest;
    try { manifest = await io.readManifest(); }
    catch (error) { if (error instanceof IndexCacheUnavailable) return result(true, true); throw error; }
    if (manifest === null) return result(true, true);
    // Primary authority faults stay outside cache-error handling.
    const active = await readActiveJournal(paths, root), identity = await readStoreIdentity(paths);
    if (active.state !== "idle" || manifest.journalGeneration !== active.generation
      || manifest.workspaceId !== identity?.workspaceId) return result(true, true);
    roots = manifest.roots;
  }
  const progress = await readReclaimProgress(root);
  spent += 1;
  // Reserve the checkpoint publication within the same budget as page work.
  const budget = limit - 1;
  const reachable = new Set(progress.visited), pending = progress.pending;
  for (const hash of Object.values(roots).filter(Boolean)) {
    if (!reachable.has(hash) && !pending.includes(hash)) pending.push(hash);
  }
  const checkpoint = async (remaining) => {
    progress.visited = [...reachable];
    progress.done = !remaining;
    try {
      await writeReclaimProgress(paths, root, progress, deadlineAt);
      spent += 1;
      return result(remaining);
    } catch { return result(true, true); }
  };
  try {
    while (pending.length > 0) {
      const hash = pending.pop();
      if (reachable.has(hash)) continue;
      if (spent >= budget || expired(deadlineAt)) {
        pending.push(hash);
        return checkpoint(true);
      }
      spent += 1;
      pending.push(...children(await io.readPage(hash)));
      reachable.add(hash);
    }
  } catch (error) {
    if (error instanceof IndexCacheUnavailable) {
      // A former root can disappear while the cache rebuilds. Do not let an
      // unreadable old stack poison every later pass; restart from authority.
      pending.length = 0;
      reachable.clear();
      progress.cursor = null;
      await checkpoint(false);
      return result(true, true);
    }
    throw error;
  }
  let entries;
  try { entries = await listDirectoryEntries(directory, { root }); }
  catch { return result(true, true); } // Cache paths alone are optional maintenance.
  let doomed, reserved = 0, remaining = false;
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || (progress.cursor !== null && entry.name <= progress.cursor)) continue;
    if (spent + reserved >= budget || expired(deadlineAt)) { remaining = true; break; }
    spent += 1;
    if (!entry.isFile() || reachable.has(entry.name.slice(0, -5))) { progress.cursor = entry.name; continue; }
    if (spent + reserved + 2 > budget) { remaining = true; break; }
    doomed ??= await detachDoomed(root);
    await assertManagedDirectory(root, directory);
    await condemn(path.join(directory, entry.name), doomed);
    spent += 1; reserved += 1;
    progress.cursor = entry.name;
  }
  if (doomed !== undefined) {
    const removed = await discard(doomed, root, budget - spent, deadlineAt);
    reclaimed += removed.spent; spent += removed.spent;
    remaining ||= !removed.drained;
  }
  return checkpoint(remaining);
}

async function discardCache(root, collect) {
  const directory = path.join(root, "indexes", "v1");
  // Only a validated cache directory may move. Damage/unsafe cache paths stay
  // untouched, and the changed durable epoch already makes their roots stale.
  try {
    await assertManagedDirectory(root, directory);
    const doomed = await detachDoomed(root);
    await condemn(directory, doomed);
    collect(directory, doomed);
  } catch { /* Cache loss or refusal cannot fail a completed primary prune. */ }
}

// Existing empty-publication journals fence physical retirement without
// introducing a new authoritative marker or a per-message flush.
export async function withIndexedPrune(paths, options, operation) {
  const { ids, firstSequence, root, deadlineAt, ...publish } = options;
  const entry = journalEntry(ids.next("transaction"), firstSequence, [], options.clock.now());
  await writeJournalEntry(paths, { ...publish, root, deadlineAt }, entry);
  const directories = new Set([root]);
  const collect = (file, doomed) => { directories.add(path.dirname(file)); directories.add(doomed); };
  try {
    await options.failAt?.("after-indexed-prune-activated");
    await discardCache(root, collect);
    return await operation(async (file, doomed) => {
      collect(file, doomed);
      await options.failAt?.("after-indexed-prune-move");
    });
  } finally {
    // A decided/applied prefix must finish its durability even after its
    // caller's deadline. POSIX flushes names; the final Windows journal flush
    // commits every earlier NTFS metadata rename.
    await syncPruneDirectories(root, directories, options);
    await options.failAt?.("before-indexed-prune-idle");
    await idleJournal(paths, { ...publish, root, durability: nameCommittedLater(options.platform) }, entry.transactionId);
  }
}
