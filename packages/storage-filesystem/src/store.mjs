import { mkdir } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT, assertPortableId, validateRecord }
  from "@agents-can-communicate/protocol";

import { encode, listDirectoryEntries, listJsonFiles, publishAtomic, readJsonIfPresent,
  retainFile } from "./atomic-json.mjs";
import { initialiseActiveJournal } from "./active-journal.mjs";
import { requireStoreIdentity } from "./identity.mjs";
import { journalEntry, readJournalCeiling, readOpenJournals, rollForward, writeJournalEntry }
  from "./journal.mjs";
import { assertEventBinding, assertStateBinding, eventPath, stateEnvelope, statePath }
  from "./record-id.mjs";
import { ephemeralIsDeleted, markEphemeral, stateDeletionPublication,
  stateGenerationIsDeleted } from "./retention.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";
import { withWriterMutex } from "./writer-mutex.mjs";

// Kept cohesive above 300 lines because durable transactions and ephemeral
// mutations must share this exact writer mutex. Splitting the two stores would
// make it easy to reintroduce separate locks and resurrect replaced sessions.

const SEQUENCE_WIDTH = 16;
export const ZERO_CURSOR = "0".repeat(SEQUENCE_WIDTH);
// No quarantine area. One was created in every workspace, named in the path
// typedef, and written to by nothing: repair deliberately refuses to move a
// corrupt record, so nothing ever had a reason to put one aside. An empty
// directory that reads as a feature is the same mistake as an attention kind
// with no rule behind it. If quarantining is ever built, it comes back with it.
const DIRECTORIES = ["state", "events", "journal", "locks", "ephemeral", "retained", "tmp"];

const pad = value => String(value).padStart(SEQUENCE_WIDTH, "0");

function assertBeforePublication(deadlineAt) {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new AccError(EXIT.CONFLICT,
      "transaction deadline expired before durable publication", {});
  }
}

export function storePaths(root) {
  return Object.freeze(Object.fromEntries([["root", root],
    ...DIRECTORIES.map(name => [name, path.join(root, name)])]));
}

async function listState(paths, root, kind) {
  const envelopes = [];
  for (const filePath of await listJsonFiles(path.join(paths.state, kind), { root })) {
    const found = await readJsonIfPresent(filePath, root);
    if (found === null) continue;
    const envelope = assertStateBinding(found.value, kind,
      path.basename(filePath, ".json"), filePath);
    if (await stateGenerationIsDeleted(paths, root, kind, envelope.id,
      envelope.generation)) continue;
    validateRecord(kind, envelope.record);
    envelopes.push(envelope);
  }
  return envelopes;
}

async function loadAllState(paths, root, wanted = null) {
  const loaded = new Map();
  const kinds = (await listDirectoryEntries(paths.state, { root }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name)
    .filter(kind => wanted === null || wanted.has(kind));
  for (const kind of kinds) {
    for (const envelope of await listState(paths, root, kind)) {
      loaded.set(`${envelope.kind}:${envelope.id}`, envelope);
    }
  }
  return loaded;
}

async function nextSequence(paths, root) {
  const last = (await listJsonFiles(paths.events, { root })).at(-1);
  return last === undefined ? 1 : Number(path.basename(last, ".json")) + 1;
}

export async function openFilesystemStore({ root, clock, ids, workspaceId, failAt }) {
  const paths = storePaths(root);
  // The caller owns the root path, so its ancestors are created here. Inside the
  // root, containment rules apply and each level is created individually so a
  // symlinked ancestor cannot be created past.
  await mkdir(root, { recursive: true });
  // Identity is settled before any read or write. Adopting a directory that
  // already belongs to another workspace is the failure this fails closed on.
  await requireStoreIdentity(paths, { workspaceId, clock });
  for (const name of DIRECTORIES) await ensureManagedDirectory(root, paths[name]);
  const publishOptions = { root, tmpDir: paths.tmp, clock, failAt };
  await initialiseActiveJournal(paths, publishOptions);

  // Any journal left behind by a crashed writer is completed before the store
  // serves a single read, so callers never observe a half-published
  // transaction even on the first open after a crash. Recovery is a write, so
  // it holds the writer mutex: two processes opening the same store at once
  // must not roll the same journal forward concurrently.
  await recoverOpenJournals();

  async function recoverOpenJournals() {
    const open = await readOpenJournals(paths, root);
    if (open.length === 0) return [];
    return withWriterMutex(paths, { root, tmpDir: paths.tmp, clock }, async () => {
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
  async function transaction(callback, { kinds, deadlineAt } = {}) {
    const wanted = kinds === undefined ? null : new Set(kinds);
    const declared = kind => {
      if (wanted !== null && !wanted.has(kind)) {
        throw new AccError(EXIT.DATA,
          `this transaction did not declare ${kind}, so it was never read`,
          { kind, declared: [...wanted] });
      }
      return kind;
    };
    return withWriterMutex(paths, { ...publishOptions, deadlineAt }, async () => {
      assertBeforePublication(deadlineAt);
      // Reads are loaded once per transaction so get, list, and the generation
      // that put() compares against all describe the same instant.
      const loaded = await loadAllState(paths, root, wanted);
      const staged = new Map();
      const events = [];
      let sequence = await nextSequence(paths, root);
      const firstSequence = pad(sequence);
      const entryFor = key => {
        const entry = staged.get(key) ?? loaded.get(key) ?? null;
        return entry?.removed === true ? null : entry;
      };

      const tx = Object.freeze({
        get(kind, id) {
          declared(kind);
          return entryFor(`${kind}:${id}`)?.record ?? null;
        },
        generationOf(kind, id) {
          declared(kind);
          return entryFor(`${kind}:${id}`)?.generation ?? null;
        },
        list(kind, predicate = () => true) {
          declared(kind);
          const merged = new Map();
          for (const source of [loaded, staged]) {
            for (const [key, entry] of source) {
              if (entry.kind === kind) merged.set(key, entry);
            }
          }
          return [...merged.values()].filter(entry => entry.removed !== true)
            .map(entry => entry.record).filter(predicate);
        },
        put(kind, id, record, expectedGeneration = null) {
          declared(kind);
          const key = `${kind}:${id}`;
          const actual = entryFor(key)?.generation ?? null;
          if (actual !== expectedGeneration) {
            throw new AccError(EXIT.CONFLICT, `${kind} ${id} changed under this transaction`,
              { kind, id, expectedGeneration, actualGeneration: actual });
          }
          validateRecord(kind, record);
          const generation = ids.next("generation");
          staged.set(key, { kind, id, record, generation });
          return generation;
        },
        remove(kind, id, expectedGeneration = null) {
          declared(kind);
          const key = `${kind}:${id}`;
          const actual = entryFor(key)?.generation ?? null;
          if (actual !== expectedGeneration) {
            throw new AccError(EXIT.CONFLICT, `${kind} ${id} changed under this transaction`,
              { kind, id, expectedGeneration, actualGeneration: actual });
          }
          const persisted = loaded.get(key);
          if (persisted === undefined) staged.delete(key);
          else staged.set(key, { kind, id, generation: persisted.generation, removed: true });
        },
        append(event) {
          const stamped = { ...event, sequence: pad(sequence) };
          sequence += 1;
          validateRecord("event", stamped);
          events.push(stamped);
          return stamped;
        },
      });

      const result = await callback(tx);

      // Events are published before state records on purpose: the event log is
      // the authority, and a crash between the two is the window the journal
      // ceiling in eventsSince has to hide.
      const publications = [
        ...events.map(event => ({
          path: path.relative(root, eventPath(paths, event.sequence)),
          bytes: encode(event),
          replace: false,
        })),
        ...[...staged.values()].map(entry => (entry.removed === true
          ? stateDeletionPublication(paths, root, entry.kind, entry.id, entry.generation,
            statePath(paths, entry.kind, entry.id))
          : {
            path: path.relative(root, statePath(paths, entry.kind, entry.id)),
            bytes: encode(stateEnvelope(entry.kind, entry.id, entry.generation, entry.record)),
            replace: true,
          })),
      ];
      if (publications.length === 0) return result;

      // Cancellation is safe up to this point: nothing durable has decided the
      // transaction. Once the journal write starts, recovery must finish it and
      // the caller waits for that atomic outcome instead of reporting a false
      // timeout while publication continues in the background.
      assertBeforePublication(deadlineAt);
      const entry = journalEntry(ids.next("transaction"), firstSequence, publications,
        clock.now());
      await writeJournalEntry(paths, publishOptions, entry);
      await failAt?.("after-journal");
      await rollForward(paths, publishOptions, entry);
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
    return { cursor: events.at(-1)?.sequence ?? after, events };
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
      return withWriterMutex(paths, publishOptions, async () => {
        await publishAtomic(ephemeralPath(kind, id), encode(record),
          { root, tmpDir: paths.tmp, replace: true });
        await markEphemeral(paths, publishOptions, kind, id, "present");
        return record;
      });
    },
    async update(kind, id, updater) {
      return withWriterMutex(paths, publishOptions, async () => {
        const next = await updater(await readEphemeral(kind, id));
        if (next === null) return null;
        validateRecord(kind, next);
        await publishAtomic(ephemeralPath(kind, id), encode(next),
          { root, tmpDir: paths.tmp, replace: true });
        await markEphemeral(paths, publishOptions, kind, id, "present");
        return next;
      });
    },
    async delete(kind, id) {
      return withWriterMutex(paths, publishOptions, async () => {
        if (await readEphemeral(kind, id) === null) return null;
        await retainFile(ephemeralPath(kind, id), { root });
        await markEphemeral(paths, publishOptions, kind, id, "deleted");
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

  return Object.freeze({ transaction, eventsSince, snapshot, ephemeral, paths, root,
    workspaceId });
}
