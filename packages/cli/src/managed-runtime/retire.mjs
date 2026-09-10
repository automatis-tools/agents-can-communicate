import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { managedDirectory, readManagedJson, syncDirectory } from "./state.mjs";

// A relative runtimeRoot resolves against the caller's cwd, not this manager's
// own root, so it can never be owned regardless of where acc uninstall runs
// from. The generations directory itself is a container, not a generation, so
// an exact match (empty relative) is foreign too. On Windows, path.relative
// returns an absolute path when the two roots sit on different drives, which
// is foreign by construction. This matches every case validateRuntime
// (state.mjs) applies to a control pointer. pathImpl is injectable only so a
// test can pin the cross-drive case through path.win32 without depending on
// the host OS; production code always uses the real, platform-native path.
export function isOwnedRuntimeRoot(generations, runtimeRoot, pathImpl = path) {
  if (typeof runtimeRoot !== "string" || !pathImpl.isAbsolute(runtimeRoot)) return false;
  const relative = pathImpl.relative(generations, runtimeRoot);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${pathImpl.sep}`)
    && !pathImpl.isAbsolute(relative);
}

/** Uninstall owns what it published. A binding naming a generation under this
 * manager is ours; one naming a foreign root, or none at all, is not, and a
 * client process is never signalled or terminated to clear a record. */
export async function retireManagedHolds({ root, workspaces }) {
  const generations = path.join(root, "generations");
  const counts = { bindings: 0, pins: 0 };
  if (await managedDirectory(workspaces)) {
    for (const entry of await readdir(workspaces, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(workspaces, entry.name, "bindings");
      if (!await managedDirectory(directory)) continue;
      let removed = false;
      for (const name of await readdir(directory)) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(directory, name);
        const record = await readManagedJson(file).catch(() => null);
        if (!isOwnedRuntimeRoot(generations, record?.runtimeRoot)) continue;
        await rm(file, { force: true });
        counts.bindings += 1;
        removed = true;
      }
      if (removed) await syncDirectory(directory);
    }
  }
  const pins = path.join(root, "pins");
  if (await managedDirectory(pins)) {
    for (const name of await readdir(pins)) {
      if (!name.endsWith(".json")) continue;
      await rm(path.join(pins, name), { force: true });
      counts.pins += 1;
    }
    await syncDirectory(pins);
  }
  return counts;
}
