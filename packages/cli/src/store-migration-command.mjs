import path from "node:path";
import { AccError, EXIT } from "@agents-can-communicate/protocol";
import { migrateFilesystemStore, STORE_VERSION } from "@agents-can-communicate/storage-filesystem";
import { listActivationBlockers } from "./managed-runtime/activation.mjs";
import { withManagerLock } from "./managed-runtime/mutex.mjs";
import { readControl } from "./managed-runtime/state.mjs";

export async function runStoreMigration({ options, context, runtime }) {
  const manager = runtime.managerRoot ?? path.join(context.dataHome, "acc", "runtime");
  let result;
  try {
    result = await withManagerLock(manager, async () => {
      const control = await readControl(manager);
      if (control !== null && control.phase !== "ready") {
        throw new AccError(EXIT.CONFLICT, "runtime admission is not ready; finish the update before store migration");
      }
      const blockers = await listActivationBlockers(manager, { incomingStoreVersion: STORE_VERSION,
        ignorePid: process.pid, strictNative: true });
      if (blockers.length > 0) {
        throw new AccError(EXIT.CONFLICT, "store migration is blocked by live users of an old or unknown contract; stop them and retry",
          { blockers });
      }
      return migrateFilesystemStore({ root: context.paths.root, workspaceId: context.descriptor.id,
        clock: runtime.clock, ids: runtime.ids, platform: runtime.platform, allowMigration: true,
        failAt: runtime.storeMigrationFailAt });
    });
  } catch (error) {
    if (error instanceof AccError) throw error;
    if (error.message === "manager lock held; acquisition timeout") {
      throw new AccError(EXIT.CONFLICT, "runtime admission is busy; retry store migration");
    }
    // Management parser errors can quote private bytes; expose no raw cause.
    throw new AccError(EXIT.DATA, "runtime admission state is unsafe or unreadable; store migration refused");
  }
  const data = { workspaceId: context.descriptor.id, ...result };
  return { data, text: result.migrated
    ? `store migrated from contract ${result.fromVersion} to ${result.toVersion}`
    : `store already uses contract ${result.toVersion}; index verified` };
}
