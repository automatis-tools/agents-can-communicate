import { AccError, EXIT, validateRecord } from "@agents-can-communicate/protocol";
import { encode, listJsonFiles, publishAtomic, readJsonIfPresent } from "./atomic-json.mjs";
import { initialiseActiveJournal, readActiveJournal } from "./active-journal.mjs";
import { assertPublicationDeadline } from "./deadline.mjs";
import { identityPath, readMigrationIdentity, STORE_VERSION } from "./identity.mjs";
import { createIndexCache } from "./index-cache.mjs";
import { IndexCacheUnavailable } from "./index-pages.mjs";
import { readOpenJournals, rollForward } from "./journal.mjs";
import { assertEventBinding } from "./record-id.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";
import { loadStateEnvelopes } from "./state-reads.mjs";
import { storePaths } from "./store.mjs";
import { withWriterMutex } from "./writer-mutex.mjs";

/** Explicit library migration; the operator must quiesce unmanaged users first. */
export async function migrateFilesystemStore({ root, workspaceId, clock, ids,
  allowMigration = false, platform = process.platform, deadlineAt, failAt }) {
  if (allowMigration !== true) {
    throw new AccError(EXIT.USAGE, "store migration requires explicit opt-in after quiescing other users");
  }
  assertPublicationDeadline(deadlineAt);
  const paths = storePaths(root), publishOptions = { root, tmpDir: paths.tmp, clock, platform, failAt };
  await readMigrationIdentity(paths, workspaceId);
  return withWriterMutex(paths, { ...publishOptions, deadlineAt }, async () => {
    const identity = await readMigrationIdentity(paths, workspaceId), fromVersion = identity.storeVersion;
    for (const directory of Object.values(paths)) await ensureManagedDirectory(root, directory);
    await initialiseActiveJournal(paths, { ...publishOptions, deadlineAt });
    for (const entry of await readOpenJournals(paths, root)) {
      // A decided journal finishes even if the migration's pre-switch budget lapses.
      await rollForward(paths, publishOptions, entry);
    }
    assertPublicationDeadline(deadlineAt);
    const primaries = await loadStateEnvelopes(paths, { root, deadlineAt });
    for (const file of await listJsonFiles(paths.events, { root })) {
      assertPublicationDeadline(deadlineAt);
      const found = await readJsonIfPresent(file, root);
      if (found === null) continue;
      const event = validateRecord("event", assertEventBinding(found.value, file));
      if (event.workspaceId !== workspaceId) throw new AccError(EXIT.DATA, "event belongs to a different workspace");
    }
    const cache = createIndexCache({ paths, root, workspaceId, publishOptions, loadPrimary: async () => primaries });
    try { await cache.rebuild(await readActiveJournal(paths, root), deadlineAt, { required: true }); }
    catch (error) {
      if (!(error instanceof IndexCacheUnavailable)) throw error;
      throw new AccError(EXIT.DATA, "store migration could not publish its complete index", { reason: error.reason });
    }
    if (fromVersion !== STORE_VERSION) {
      await failAt?.("before-store-version-switch");
      assertPublicationDeadline(deadlineAt);
      await publishAtomic(identityPath(paths), encode({ ...identity, storeVersion: STORE_VERSION }),
        { ...publishOptions, deadlineAt, replace: true, durability: "full" });
      await failAt?.("after-store-version-switch");
    }
    return { fromVersion, toVersion: STORE_VERSION, migrated: fromVersion !== STORE_VERSION };
  });
}
