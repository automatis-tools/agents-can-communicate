import path from "node:path";

import { AccError, EXIT, validateRecord } from "@agents-can-communicate/protocol";

import { encode, listDirectoryEntries, listJsonFiles, publishAtomic, readJsonIfPresent,
  removeIfPresent } from "./atomic-json.mjs";
import { requireStoreIdentity } from "./identity.mjs";
import { journalEntry, readOpenJournals, rollForward, writeJournalEntry } from "./journal.mjs";
import { assertEventBinding, assertStateBinding, eventPath, stateEnvelope, statePath }
  from "./record-id.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";
import { withWriterMutex } from "./writer-mutex.mjs";

const SEQUENCE_WIDTH = 16;
export const ZERO_CURSOR = "0".repeat(SEQUENCE_WIDTH);
const DIRECTORIES = ["state", "events", "journal", "locks", "quarantine", "ephemeral", "tmp"];

const pad = value => String(value).padStart(SEQUENCE_WIDTH, "0");

export function storePaths(root) {
  return Object.freeze(Object.fromEntries([["root", root],
    ...DIRECTORIES.map(name => [name, path.join(root, name)])]));
}

async function listState(paths, root, kind) {
  const envelopes = [];
  for (const filePath of await listJsonFiles(path.join(paths.state, kind), { root })) {
    const found = await readJsonIfPresent(filePath, root);
    if (found === null) continue;
    envelopes.push(assertStateBinding(found.value, kind,
      path.basename(filePath, ".json"), filePath));
  }
  return envelopes;
}

async function loadAllState(paths, root) {
  const loaded = new Map();
  const kinds = (await listDirectoryEntries(paths.state, { root }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
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
  for (const name of DIRECTORIES) await ensureManagedDirectory(root, paths[name]);
  // Identity is settled before any read or write. Adopting a directory that
  // already belongs to another workspace is the failure this fails closed on.
  await requireStoreIdentity(paths, { workspaceId, clock });
  const publishOptions = { root, tmpDir: paths.tmp, clock, failAt };

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

  async function transaction(callback) {
    return withWriterMutex(paths, publishOptions, async () => {
      // Reads are loaded once per transaction so get, list, and the generation
      // that put() compares against all describe the same instant.
      const loaded = await loadAllState(paths, root);
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
          return entryFor(`${kind}:${id}`)?.record ?? null;
        },
        generationOf(kind, id) {
          return entryFor(`${kind}:${id}`)?.generation ?? null;
        },
        list(kind, predicate = () => true) {
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
          const key = `${kind}:${id}`;
          const actual = entryFor(key)?.generation ?? null;
          if (actual !== expectedGeneration) {
            throw new AccError(EXIT.CONFLICT, `${kind} ${id} changed under this transaction`,
              { kind, id, expectedGeneration, actualGeneration: actual });
          }
          staged.set(key, { kind, id, removed: true });
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
          ? { path: path.relative(root, statePath(paths, entry.kind, entry.id)), remove: true }
          : {
            path: path.relative(root, statePath(paths, entry.kind, entry.id)),
            bytes: encode(stateEnvelope(entry.kind, entry.id, entry.generation, entry.record)),
            replace: true,
          })),
      ];
      if (publications.length === 0) return result;

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
    const ceiling = (await readOpenJournals(paths, root)).at(0)?.firstSequence ?? null;
    const events = [];
    for (const filePath of await listJsonFiles(paths.events, { root })) {
      const sequence = path.basename(filePath, ".json");
      if (sequence <= after) continue;
      if (ceiling !== null && sequence >= ceiling) break;
      const found = await readJsonIfPresent(filePath, root);
      if (found === null) continue;
      const event = assertEventBinding(found.value, filePath);
      if (event.workspaceId !== workspace) continue;
      events.push(event);
      if (events.length === limit) break;
    }
    return { cursor: events.at(-1)?.sequence ?? after, events };
  }

  async function snapshot(workspace) {
    const of = async kind => (await listState(paths, root, kind))
      .map(envelope => envelope.record)
      .filter(record => record.workspaceId === workspace);
    return {
      workspace: (await of("workspace"))[0] ?? null,
      participants: await of("participant"),
      sessions: await of("session"),
      intents: await of("intent"),
      workstreams: await of("workstream"),
      tasks: await of("task"),
      claims: await of("claim"),
    };
  }

  // Ephemeral records are published by replace and never journalled: they carry
  // no history, append no events, and are expected to disappear.
  const ephemeralPath = (kind, id) => path.join(paths.ephemeral, kind, `${id}.json`);
  const ephemeral = Object.freeze({
    async get(kind, id) {
      const found = await readJsonIfPresent(ephemeralPath(kind, id), root);
      return found?.value ?? null;
    },
    async put(kind, id, record) {
      await publishAtomic(ephemeralPath(kind, id), encode(record),
        { root, tmpDir: paths.tmp, replace: true });
      return record;
    },
    async delete(kind, id) {
      await removeIfPresent(ephemeralPath(kind, id));
    },
    async list(kind) {
      const records = [];
      for (const filePath of await listJsonFiles(path.join(paths.ephemeral, kind), { root })) {
        const found = await readJsonIfPresent(filePath, root);
        if (found !== null) records.push(found.value);
      }
      return records;
    },
  });

  return Object.freeze({ transaction, eventsSince, snapshot, ephemeral, paths, root,
    workspaceId });
}
