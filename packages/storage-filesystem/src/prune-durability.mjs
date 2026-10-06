import path from "node:path";
import { doomedDirectories } from "./doomed-directory.mjs";
import { isWindows, syncEntry } from "./portable-fs.mjs";
import { assertManagedDirectory } from "./safe-directory.mjs";

// A decided prune finishes its applied prefix even after its deadline. On
// Windows the final idle-journal file flush commits earlier NTFS renames.
export async function syncPruneDirectories(root, directories, { platform } = {}) {
  if (isWindows(platform)) return;
  for (const directory of directories) {
    try { await assertManagedDirectory(root, directory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await syncEntry(directory, directory, { platform });
  }
}

// Empty-publication journals are physical indexed prunes. Process death loses
// their in-memory affected-directory set; conservatively fence every possible
// primary/marker parent before idle permits a current negative cache. No new
// journal format or per-record publication is needed.
export async function recoverPruneDurability(paths, { root, platform } = {}) {
  if (isWindows(platform)) return;
  const directories = [
    ...["message", "receipt"].flatMap(kind => [path.join(paths.state, kind),
      path.join(paths.retained, "state", kind)]),
    ...await doomedDirectories(root), root,
  ];
  await syncPruneDirectories(root, directories, { platform });
}
