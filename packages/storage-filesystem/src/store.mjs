import { mkdir } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT, TRANSACTION_INDEXES, assertIndexTuple, assertPortableId, indexKeysFor, validateRecord }
  from "@agents-can-communicate/protocol";

import { encode, listJsonFiles, publishAtomic, readJsonIfPresent,
  retainFile } from "./atomic-json.mjs";
import { initialiseActiveJournal, readActiveJournal } from "./active-journal.mjs";
import { publicationPath } from "./publication-path.mjs";
import { assertPublicationDeadline } from "./deadline.mjs";
import { requireStoreIdentity } from "./identity.mjs";
import { journalEntry, readJournalCeiling, readOpenJournals, rollForward, writeJournalEntry }
  from "./journal.mjs";
import { assertEventBinding, eventPath, stateEnvelope, statePath }
  from "./record-id.mjs";
import { ephemeralIsDeleted, markEphemeral, stateDeletionPublication } from "./retention.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";
import { readEventFloor } from "./event-floor.mjs";
import { reclaimStateRecords, trimEventLog } from "./reclaim.mjs";
import { sweepIfDue } from "./stage-sweep.mjs";
import { withWriterMutex } from "./writer-mutex.mjs";
import { listState, loadStateEnvelopes, readStateEnvelope } from "./state-reads.mjs";
import { createTransactionView, transactionKinds } from "./transaction-view.mjs";
import { createIndexCache } from "./index-cache.mjs";
import { IndexCacheUnavailable } from "./index-pages.mjs";

// Kept cohesive above 300 lines because durable transactions and ephemeral
// mutations must share this exact writer mutex. Splitting the two stores would
// make it easy to reintroduce separate locks and resurrect replaced sessions.

const SEQUENCE_WIDTH = 16;
// An ephemeral record describes a live session. A crash of the machine ends
// every session it describes, and a session whose record comes back as its
// previous version, or not at all, is recovered by its next hook. Its bytes are
// still flushed, so no reader finds a torn record.
const EPHEMERAL = "bytes";
export const ZERO_CURSOR = "0".repeat(SEQUENCE_WIDTH);
// No quarantine area. One was created in every workspace, named in the path
// typedef, and written to by nothing: repair deliberately refuses to move a
// corrupt record, so nothing ever had a reason to put one aside. An empty
// directory that reads as a feature is the same mistake as an attention kind
// with no rule behind it. If quarantining is ever built, it comes back with it.
//
// `stage` is the counter-example that keeps that rule rather than breaking it:
// every immutable publication fills it and stage-sweep.mjs empties it. Holding
// accepted stages apart from the partials in `tmp` is what lets the sweep
// remove a whole directory instead of deciding file by file from a filename
// suffix. A `stage` ever found empty by design rather than by sweeping is the
// mistake described above, and should go.
const DIRECTORIES = ["state", "events", "journal", "locks", "ephemeral", "retained", "tmp",
  "stage"];

const pad = value => String(value).padStart(SEQUENCE_WIDTH, "0");

export function storePaths(root) {
  return Object.freeze(Object.fromEntries([["root", root],
    ...DIRECTORIES.map(name => [name, path.join(root, name)])]));
}

async function nextSequence(paths, root) {
  const last = (await listJsonFiles(paths.events, { root })).at(-1);
  // Only an empty directory consults the floor, so the path every transaction
  // runs pays nothing for retention. Trimming removes the oldest events, so
  // while any file remains the newest one still answers this. A log trimmed
  // away entirely is the case that would otherwise restart at 1 and hand out a
  // sequence a peer already holds a cursor for.
  const highest = last === undefined
    ? await readEventFloor(paths, root)
    : path.basename(last, ".json");
  if (highest === null) return 1;
  // Counted as a BigInt whichever side it came from. A 16-digit sequence
  // reaches past Number.MAX_SAFE_INTEGER, where adding one stops changing the
  // value, so a Number here would eventually hand out a sequence twice.
  // Refusing is the only honest answer left at that point.
  const next = BigInt(highest) + 1n;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AccError(EXIT.DATA, "event sequence is exhausted", { highest });
  }
  return Number(next);
}

export async function openFilesystemStore({ root, clock, ids, workspaceId, failAt,
  deadlineAt: storeDeadline, platform = process.platform }) {
  assertPublicationDeadline(storeDeadline);
  const paths = storePaths(root);
  // The caller owns the root path, so its ancestors are created here. Inside the
  // root, containment rules apply and each level is created individually so a
  // symlinked ancestor cannot be created past.
  await mkdir(root, { recursive: true });
  // Identity is settled before any read or write. Adopting a directory that
  // already belongs to another workspace is the failure this fails closed on.
  await requireStoreIdentity(paths, { workspaceId, clock, platform });
  for (const name of DIRECTORIES) await ensureManagedDirectory(root, paths[name]);
  const publishOptions = { root, tmpDir: paths.tmp, clock, failAt, platform };
  const indexCache = createIndexCache({ paths, root, workspaceId, publishOptions,
    loadPrimary: options => loadStateEnvelopes(paths, { root, ...options }, new Set(["message", "receipt"])) });
  await initialiseActiveJournal(paths, publishOptions);

  // Any journal left behind by a crashed writer is completed before the store
  // serves a single read, so callers never observe a half-published
  // transaction even on the first open after a crash. Recovery is a write, so
  // it holds the writer mutex: two processes opening the same store at once
  // must not roll the same journal forward concurrently.
  await recoverOpenJournals();

  // Sweeping is a write, so it holds the same mutex recovery does, and no
  // transaction publishes while the stage directory is detached. A store that is
  // still opening beside it does: the identity record, the directory checks and
  // the journal's first slot above run without the mutex, so the managed
  // directory checks and publishAtomic take a `stage` that left its name once
  // more rather than failing (CI on #217). It is bounded
  // per pass: a store carrying a large accumulation drains over several opens
  // rather than spending one hook's whole budget on it. The mutex is taken only
  // on the opens that actually sweep - see sweepIfDue, which decides before it
  // locks, because this runs inside every hook.
  // Maintenance never decides whether a store can be opened: sweepIfDue answers
  // a lost lock and a lapsed budget itself, and raises only real store faults.
  await sweepIfDue(paths, { root, clock, deadlineAt: storeDeadline,
    withLock: operation => withWriterMutex(paths,
      { root, tmpDir: paths.tmp, clock, deadlineAt: storeDeadline }, operation) });

  async function recoverOpenJournals() {
    const open = await readOpenJournals(paths, root);
    if (open.length === 0) return [];
    return withWriterMutex(paths, { root, tmpDir: paths.tmp, clock, deadlineAt: storeDeadline }, async () => {
      const completed = [];
      for (const entry of await readOpenJournals(paths, root)) {
        completed.push(...await rollForward(paths, { root, tmpDir: paths.tmp, clock }, entry));
      }
      return completed;
    });
  }

  /**
   * Run a write, having read the kinds it declared and no others.
   *
   * A transaction used to read every record the workspace held, for the
   * generation checks `put` makes. That put the cost of `acc message` in
   * proportion to everything the workspace already contained - 400 messages
   * written one after another took 163 seconds, the last of them half a second
   * each - and some of these transactions run inside hooks, where the budget is
   * five seconds and running out means failing open.
   *
   * `kinds` is enforced, not merely honoured: reaching for an undeclared kind
   * throws. A silent empty list would be the worst of both, since every check
   * these transactions make reads as "nothing conflicts" when it finds nothing.
   * Declaring nothing reads everything, which is what this always did.
   */
  async function transaction(callback, { kinds, exactKinds = [], deadlineAt } = {}) {
    // A caller may tighten this invocation's budget, never extend it.
    deadlineAt = Math.min(deadlineAt ?? Infinity, storeDeadline ?? Infinity);
    const { eager } = transactionKinds(kinds, exactKinds);
    return withWriterMutex(paths, { ...publishOptions, deadlineAt }, async () => {
      assertPublicationDeadline(deadlineAt);
      // An already-open handle may follow a writer that died after deciding.
      // Recovery here holds this mutex directly, never trying to acquire it twice.
      for (const entry of await readOpenJournals(paths, root)) await rollForward(paths, publishOptions, entry);
      const before = await readActiveJournal(paths, root);
      // Reads are loaded once per transaction so get, list, and the generation
      // that put() compares against all describe the same instant.
      const loaded = await loadStateEnvelopes(paths, { root }, eager);
      const events = [];
      let sequence = await nextSequence(paths, root);
      const firstSequence = pad(sequence);
      const view = createTransactionView({ kinds, exactKinds, loaded, ids,
        loadEnvelope: (kind, id) => {
          assertPublicationDeadline(deadlineAt);
          return readStateEnvelope(paths, { root, workspaceId }, kind, id);
        },
        lookupIndex(index, tuple, context) {
          assertIndexTuple(index, tuple);
          const kind = TRANSACTION_INDEXES[index].kind;
          context.declared(kind);
          return indexCache.lookup(index, tuple, { active: before, staged: context.staged, deadlineAt,
            verify: async id => {
              const envelope = await context.read(kind, id);
              if (envelope === null) return false;
              if (!indexKeysFor(kind, envelope.record).some(key => key.index === index
                && JSON.stringify(key.tuple) === JSON.stringify(tuple))) {
                throw new IndexCacheUnavailable("invalid_source_reference");
              }
              return true;
            } });
        },
        appendEvent(event) {
          const stamped = { ...event, sequence: pad(sequence) };
          sequence += 1;
          validateRecord("event", stamped);
          events.push(stamped);
          return stamped;
        } });
      const { tx, staged } = view;
      let result;
      try { result = await callback(tx); }
      catch (error) {
        await view.finish().catch(() => {});
        throw error;
      }
      await view.finish();
      const deltas = indexCache.prepareDeltas(loaded, staged);

      // Events are published before state records on purpose: the event log is
      // the authority, and a crash between the two is the window the journal
      // ceiling in eventsSince has to hide.
      const publications = [
        ...events.map(event => ({
          path: publicationPath(root, eventPath(paths, event.sequence)),
          bytes: encode(event),
          replace: false,
        })),
        ...[...staged.values()].map(entry => (entry.removed === true
          ? stateDeletionPublication(paths, root, entry.kind, entry.id, entry.generation,
            statePath(paths, entry.kind, entry.id))
          : {
            path: publicationPath(root, statePath(paths, entry.kind, entry.id)),
            bytes: encode(stateEnvelope(entry.kind, entry.id, entry.generation, entry.record)),
            replace: true,
          })),
      ];
      if (publications.length === 0) return result;

      // One record replaced and nothing appended - a session's heartbeat, every
      // turn - needs no journal to appear at once: the rename replaces it
      // atomically, and the bytes are flushed before and after it. The journal
      // cost five atomic writes for it, ten flushes on Windows at 8 to 23 ms
      // each (windows-latest). Only while no other transaction is open: an open
      // one would later roll its own bytes over this record, and it refuses a
      // journalled write too, which the path below keeps.
      const [only] = staged.values();
      if (events.length === 0 && staged.size === 1 && only.removed !== true
        && !["message", "receipt"].includes(only.kind) && before.state === "idle") {
        assertPublicationDeadline(deadlineAt);
        await publishAtomic(statePath(paths, only.kind, only.id), publications[0].bytes,
          { ...publishOptions, replace: true, deadlineAt });
        return result;
      }

      // Preparation is still cancellable. The active journal's atomic
      // publication decides the write; roll-forward must then finish even if
      // this invocation expires, so its publication options carry no deadline.
      assertPublicationDeadline(deadlineAt);
      const entry = journalEntry(ids.next("transaction"), firstSequence, publications,
        clock.now());
      await writeJournalEntry(paths, { ...publishOptions, deadlineAt }, entry);
      await failAt?.("after-journal");
      await rollForward(paths, publishOptions, entry);
      await indexCache.commit({ before, after: await readActiveJournal(paths, root), deltas, deadlineAt });
      return result;
    });
  }

  async function eventsSince(workspace, cursor, limit) {
    const after = cursor ?? ZERO_CURSOR;
    // An open journal marks a transaction that is decided but not fully
    // published. Bounding the page below its first sequence is what keeps a
    // partially published transaction invisible to every reader.
    const ceiling = await readJournalCeiling(paths, root);
    const events = [];
    for (const filePath of await listJsonFiles(paths.events, { root })) {
      const sequence = path.basename(filePath, ".json");
      if (sequence <= after) continue;
      if (ceiling !== null && sequence >= ceiling) break;
      const found = await readJsonIfPresent(filePath, root);
      if (found === null) continue;
      const event = validateRecord("event", assertEventBinding(found.value, filePath));
      if (event.workspaceId !== workspace) continue;
      events.push(event);
      if (events.length === limit) break;
    }
    // A caller whose cursor precedes the boundary is served what is left and
    // told where the log now starts. A short page that reads like a complete
    // one is the failure trimming must not introduce.
    return { cursor: events.at(-1)?.sequence ?? after, events,
      trimmedThrough: await readEventFloor(paths, root) };
  }

  /**
   * Read the durable state, or the part of it a caller actually needs.
   *
   * Every kind is read by default, which is what most callers want and what
   * this always did. `kinds` exists because one caller runs in front of every
   * file an agent writes: reading the whole store there made the write guard
   * cost grow with the number of messages the workspace had ever carried, and
   * the hook budget is five seconds after which it allows the write.
   */
  /**
   * One state record by id, or null - the checks a listing applies to each
   * record (the path names it, a deleted generation is absent, the record
   * validates, it belongs to this workspace) without reading every other
   * record of its kind. Looking one session up by listing them all cost a full
   * pass over every session the workspace ever had, several times a hook.
   */
  async function stateRecord(workspace, kind, id) {
    const envelope = await readStateEnvelope(paths, { root }, kind, id);
    return envelope?.record.workspaceId === workspace ? envelope.record : null;
  }

  async function snapshot(workspace, { kinds } = {}) {
    const wanted = kinds === undefined ? null : new Set(kinds);
    const of = async kind => {
      if (wanted !== null && !wanted.has(kind)) return [];
      return (await listState(paths, root, kind))
        .map(envelope => envelope.record)
        .filter(record => record.workspaceId === workspace);
    };
    return {
      workspace: (await of("workspace"))[0] ?? null,
      participants: await of("participant"),
      sessions: await of("session"),
      intents: await of("intent"),
      claims: await of("claim"),
      messages: await of("message"),
      receipts: await of("receipt"),
    };
  }
  // Ephemeral records are published by replace and never journalled: they carry
  // no durable history and append no events. Deletion is represented by a
  // retained marker because Node cannot unlink safely through a directory fd.
  const ephemeralDirectory = kind => {
    assertPortableId(kind, "ephemeral record kind");
    return path.join(paths.ephemeral, kind);
  };
  const ephemeralPath = (kind, id) => {
    assertPortableId(id, "ephemeral record id");
    return path.join(ephemeralDirectory(kind), `${id}.json`);
  };
  const readEphemeral = async (kind, id) => {
    const found = await readJsonIfPresent(ephemeralPath(kind, id), root);
    if (found === null || await ephemeralIsDeleted(paths, root, kind, id)) return null;
    return validateRecord(kind, found.value);
  };
  const ephemeral = Object.freeze({
    async get(kind, id) {
      return readEphemeral(kind, id);
    },
    async put(kind, id, record) {
      validateRecord(kind, record);
      return withWriterMutex(paths, { ...publishOptions, deadlineAt: storeDeadline }, async () => {
        await publishAtomic(ephemeralPath(kind, id), encode(record),
          { root, tmpDir: paths.tmp, replace: true, durability: EPHEMERAL, deadlineAt: storeDeadline });
        // Once record bytes are accepted, finish the same logical publication.
        await markEphemeral(paths, publishOptions, kind, id, "present");
        return record;
      });
    },
    async update(kind, id, updater, { deadlineAt = storeDeadline } = {}) {
      deadlineAt = Math.min(deadlineAt ?? Infinity, storeDeadline ?? Infinity);
      return withWriterMutex(paths, { ...publishOptions, deadlineAt }, async () => {
        const next = await updater(await readEphemeral(kind, id));
        if (next === null) return null;
        validateRecord(kind, next);
        assertPublicationDeadline(deadlineAt);
        await publishAtomic(ephemeralPath(kind, id), encode(next),
          { root, tmpDir: paths.tmp, replace: true, durability: EPHEMERAL, deadlineAt });
        await markEphemeral(paths, publishOptions, kind, id, "present");
        return next;
      });
    },
    async delete(kind, id, guard = () => true) {
      return withWriterMutex(paths, { ...publishOptions, deadlineAt: storeDeadline }, async () => {
        // Decide and delete under the same lock; a caller may be retiring an
        // old generation while its replacement is waiting to write this id.
        const current = await readEphemeral(kind, id);
        if (current === null || !await guard(current)) return null;
        await retainFile(ephemeralPath(kind, id), { root });
        await markEphemeral(paths, { ...publishOptions, deadlineAt: storeDeadline }, kind, id, "deleted");
        return null;
      });
    },
    async list(kind) {
      const records = [];
      for (const filePath of await listJsonFiles(ephemeralDirectory(kind), { root })) {
        const found = await readJsonIfPresent(filePath, root);
        if (found !== null && !await ephemeralIsDeleted(paths, root, kind,
          path.basename(filePath, ".json"))) records.push(validateRecord(kind, found.value));
      }
      return records;
    },
  });

  /**
   * Every live state record with the generation that identifies it.
   *
   * `snapshot` deliberately hands back records alone, because that is all any
   * reader of coordination state needs. Reclaiming is the one caller that needs
   * the envelope generation too: it decides what is eligible from a reading
   * taken outside the writer mutex and applies it inside, and the generation is
   * what proves the record did not change in between.
   */
  async function stateEnvelopes(workspace, { kinds } = {}) {
    const wanted = kinds === undefined ? null : new Set(kinds);
    return [...(await loadStateEnvelopes(paths, { root }, wanted)).values()]
      .filter(envelope => envelope.record.workspaceId === workspace);
  }

  /**
   * Remove named state records and the retention markers they own.
   *
   * Under the writer mutex, because it competes with every transaction; the
   * store deadline still bounds it, so an operator waiting on a busy store is
   * told rather than blocked forever.
   */
  async function reclaimRecords(plan, { limit, deadlineAt } = {}) {
    const bounded = Math.min(deadlineAt ?? Infinity, storeDeadline ?? Infinity);
    return withWriterMutex(paths, { ...publishOptions, deadlineAt: bounded }, async () => {
      // A function is decided here, holding the mutex, because eligibility is a
      // statement about relationships between records and not only about each
      // record. The generation on an entry proves that record did not change;
      // it says nothing about a session opening for a participant this was
      // about to remove. Deciding inside the lock is what closes that.
      const entries = typeof plan === "function" ? await plan() : plan;
      return reclaimStateRecords(paths, entries, { root, limit, deadlineAt: bounded });
    });
  }

  /**
   * Trim the event log to a boundary and report where it now starts.
   *
   * Under the writer mutex, because it competes with the sequence every
   * transaction allocates.
   */
  async function trimHistory(boundary, { limit, deadlineAt } = {}) {
    const bounded = Math.min(deadlineAt ?? Infinity, storeDeadline ?? Infinity);
    const publish = { ...publishOptions, deadlineAt: bounded };
    return withWriterMutex(paths, publish,
      () => trimEventLog(paths, boundary, { root, publish, limit, deadlineAt: bounded }));
  }

  return Object.freeze({ transaction, eventsSince, snapshot, stateRecord, stateEnvelopes,
    reclaimRecords, trimHistory, ephemeral, paths, root, workspaceId,
    indexDiagnostics: indexCache.diagnostics });
}
