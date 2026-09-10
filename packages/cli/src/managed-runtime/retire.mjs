import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { managedDirectory, readManagedJson, syncDirectory } from "./state.mjs";

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
        const runtimeRoot = record?.runtimeRoot;
        // path.relative silently resolves a non-absolute second argument against
        // the caller's cwd, so a relative runtimeRoot must never reach it - that
        // would make ownership depend on where acc uninstall happened to run
        // from. The generations directory itself is a container, not a
        // generation, so an exact match (empty relative) is foreign too. Same
        // rule validateRuntime in state.mjs applies to a control pointer.
        const relative = typeof runtimeRoot === "string" && path.isAbsolute(runtimeRoot)
          ? path.relative(generations, runtimeRoot) : null;
        const owned = relative !== null && relative !== "" && relative !== ".."
          && !relative.startsWith(`..${path.sep}`);
        if (!owned) continue;
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
