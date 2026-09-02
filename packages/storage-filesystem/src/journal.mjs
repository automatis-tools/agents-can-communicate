import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { activateJournal, idleJournal, readActiveJournal } from "./active-journal.mjs";
import { encode, publishAtomic, readJsonIfPresent, retainFile }
  from "./atomic-json.mjs";
import { completeJournal } from "./retention.mjs";

export const JOURNAL_VERSION = 2;

// A journal entry is prepared only after the transaction callback has
// succeeded and every byte is known. The subsequent synced active-log record
// is the commit point: an orphan prepared journal is not a decided
// transaction. Roll-forward is idempotent because identical immutable bytes
// are accepted and materialised state carries generations.
export function journalPath(paths, transactionId) {
  assertPortableId(transactionId, "transaction id");
  return path.join(paths.journal, `${transactionId}.json`);
}

function publicationDestination(root, publicationPath) {
  if (typeof publicationPath !== "string" || publicationPath === ""
    || path.isAbsolute(publicationPath) || path.win32.isAbsolute(publicationPath)) {
    throw new AccError(EXIT.DATA, "journal publication path must be relative",
      { publicationPath });
  }
  const segments = publicationPath.split(/[\\/]/);
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new AccError(EXIT.DATA, "journal publication path is not managed",
      { publicationPath });
  }
  const durablePublication = segments[0] === "events" || segments[0] === "state";
  const stateRetention = segments[0] === "retained" && segments[1] === "state";
  if (!(durablePublication || stateRetention)) {
    throw new AccError(EXIT.DATA, "journal publication path is not managed",
      { publicationPath });
  }
  const destination = path.resolve(root, ...segments);
  const relative = path.relative(root, destination);
  if (relative === "" || path.isAbsolute(relative) || relative === ".."
    || relative.startsWith(`..${path.sep}`)) {
    throw new AccError(EXIT.DATA, "journal publication path escapes the store root",
      { publicationPath, root });
  }
  return destination;
}

export function journalEntry(transactionId, firstSequence, publications, startedAt) {
  return {
    journalVersion: JOURNAL_VERSION,
    transactionId,
    firstSequence,
    startedAt,
    publications: publications.map(item => ({
      path: item.path,
      bytes: item.bytes.toString("base64"),
      replace: item.replace === true,
      retainedPath: item.retainedPath ?? null,
    })),
  };
}

export async function writeJournalEntry(paths, options, entry) {
  await publishAtomic(journalPath(paths, entry.transactionId), encode(entry), options);
  await options.failAt?.("after-journal-prepared");
  await activateJournal(paths, options, entry);
  return entry;
}

export async function retireJournalEntry(paths, options, transactionId) {
  await retainFile(journalPath(paths, transactionId), { root: paths.root });
  await completeJournal(paths, options, transactionId);
  await options.failAt?.("before-journal-idle");
  await idleJournal(paths, options, transactionId);
}

export async function readOpenJournals(paths, root) {
  const active = await readActiveJournal(paths, root);
  if (active.state === "idle") return [];
  const file = journalPath(paths, active.transactionId);
  const found = await readJsonIfPresent(file, root);
  if (found === null) {
    throw new AccError(EXIT.DATA, "active journal entry is missing", { file });
  }
  const entry = found.value;
  if (entry?.journalVersion !== JOURNAL_VERSION) {
    throw new AccError(EXIT.DATA, "unknown journal version", { file,
      journalVersion: entry?.journalVersion });
  }
  if (path.basename(file, ".json") !== entry.transactionId
    || entry.transactionId !== active.transactionId
    || entry.firstSequence !== active.firstSequence) {
    throw new AccError(EXIT.DATA, "journal entry does not match its active record", { file });
  }
  assertPortableId(entry.transactionId, "transaction id");
  if (!Array.isArray(entry.publications)) {
    throw new AccError(EXIT.DATA, "journal publications must be an array", { file });
  }
  for (const publication of entry.publications) {
    publicationDestination(root, publication?.path);
    if (publication?.retainedPath !== null) {
      publicationDestination(root, publication?.retainedPath);
    }
  }
  return [entry];
}

export async function readJournalCeiling(paths, root) {
  const active = await readActiveJournal(paths, root);
  return active.state === "open" ? active.firstSequence : null;
}

// Publishing every listed file and then retiring the entry. Already-published
// identical bytes are accepted, differing bytes fail closed, so running this
// twice changes nothing and a genuine conflict is never papered over.
export async function rollForward(paths, options, entry) {
  const published = [];
  for (const publication of entry.publications) {
    const destination = publicationDestination(options.root, publication.path);
    if (publication.retainedPath !== null) {
      await retainFile(publicationDestination(options.root, publication.retainedPath),
        { root: options.root });
    }
    const bytes = Buffer.from(publication.bytes, "base64");
    const outcome = await publishAtomic(destination, bytes,
      { ...options, replace: publication.replace === true });
    if (outcome === "published") published.push(publication.path);
    // Seam for the crash-window tests: abort between two publications of the
    // same decided transaction.
    await options.failAt?.(`after:${publication.path}`);
  }
  await retireJournalEntry(paths, options, entry.transactionId);
  return published;
}
