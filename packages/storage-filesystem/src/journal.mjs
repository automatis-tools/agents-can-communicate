import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { encode, listJsonFiles, publishAtomic, readJsonIfPresent, removeIfPresent }
  from "./atomic-json.mjs";

export const JOURNAL_VERSION = 1;

// A journal entry is written only after the transaction callback has succeeded
// and every byte is known. Its existence therefore means "this transaction was
// decided", which is what makes roll-forward - rather than rollback - the
// correct recovery. Roll-forward is idempotent because publication is
// no-replace and identical bytes are accepted as already published.
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
  if (!(["events", "state"].includes(segments[0]))) {
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
  await removeIfPresent(journalPath(paths, transactionId), { root: paths.root });
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
    assertPortableId(entry.transactionId, "transaction id");
    if (!Array.isArray(entry.publications)) {
      throw new AccError(EXIT.DATA, "journal publications must be an array", { file });
    }
    for (const publication of entry.publications) {
      publicationDestination(root, publication?.path);
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
    const destination = publicationDestination(options.root, publication.path);
    if (publication.remove === true) {
      await removeIfPresent(destination, { root: options.root });
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
