import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { encode, listJsonFiles, publishAtomic, readJsonIfPresent, removeIfPresent }
  from "./atomic-json.mjs";

export const JOURNAL_VERSION = 1;

// A journal entry is written only after the transaction callback has succeeded
// and every byte is known. Its existence therefore means "this transaction was
// decided", which is what makes roll-forward - rather than rollback - the
// correct recovery. Roll-forward is idempotent because publication is
// no-replace and identical bytes are accepted as already published.
export function journalPath(paths, transactionId) {
  return path.join(paths.journal, `${transactionId}.json`);
}

export function journalEntry(transactionId, firstSequence, publications, startedAt) {
  return {
    journalVersion: JOURNAL_VERSION,
    transactionId,
    firstSequence,
    startedAt,
    publications: publications.map(item => ({
      path: item.path,
      // A removal is journalled like any other publication, so a crash between
      // two deletions replays to the same end state rather than a partial one.
      bytes: item.remove === true ? null : item.bytes.toString("base64"),
      replace: item.replace === true,
      remove: item.remove === true,
    })),
  };
}

export async function writeJournalEntry(paths, options, entry) {
  await publishAtomic(journalPath(paths, entry.transactionId), encode(entry), options);
  return entry;
}

export async function retireJournalEntry(paths, transactionId) {
  await removeIfPresent(journalPath(paths, transactionId));
}

export async function readOpenJournals(paths, root) {
  const files = await listJsonFiles(paths.journal, { root });
  const entries = [];
  for (const file of files) {
    const found = await readJsonIfPresent(file, root);
    if (found === null) continue;
    const entry = found.value;
    if (entry?.journalVersion !== JOURNAL_VERSION) {
      throw new AccError(EXIT.DATA, "unknown journal version", { file,
        journalVersion: entry?.journalVersion });
    }
    if (path.basename(file, ".json") !== entry.transactionId) {
      throw new AccError(EXIT.DATA, "journal entry does not match its filename", { file });
    }
    entries.push(entry);
  }
  return entries.sort((left, right) => left.firstSequence.localeCompare(right.firstSequence));
}

// Publishing every listed file and then retiring the entry. Already-published
// identical bytes are accepted, differing bytes fail closed, so running this
// twice changes nothing and a genuine conflict is never papered over.
export async function rollForward(paths, options, entry) {
  const published = [];
  for (const publication of entry.publications) {
    const destination = path.resolve(options.root, publication.path);
    if (publication.remove === true) {
      await removeIfPresent(destination);
      published.push(publication.path);
      await options.failAt?.(`after:${publication.path}`);
      continue;
    }
    const bytes = Buffer.from(publication.bytes, "base64");
    const outcome = await publishAtomic(destination, bytes,
      { ...options, replace: publication.replace === true });
    if (outcome === "published") published.push(publication.path);
    // Seam for the crash-window tests: abort between two publications of the
    // same decided transaction.
    await options.failAt?.(`after:${publication.path}`);
  }
  await retireJournalEntry(paths, entry.transactionId);
  return published;
}
