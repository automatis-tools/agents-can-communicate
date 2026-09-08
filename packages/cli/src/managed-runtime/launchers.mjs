import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ENTRY_KINDS } from "./entry.mjs";
import { managedDirectory, syncDirectory } from "./state.mjs";

const MODULES = ["entry.mjs", "state.mjs", "mutex.mjs", "leases.mjs", "schedule.mjs", "policy.mjs"];
async function durableFile(file, bytes, mode = 0o600) {
  const handle = await open(file, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

export const stablePaths = root => ({
  cli: path.join(root, "bin", "acc.mjs"), runner: path.join(root, "bin", "acc-hook.mjs"),
  bootstrap: path.join(root, "bin", "acc-bootstrap.mjs"),
  channel: path.join(root, "bin", "acc-claude-channel.mjs"),
});

/** Publish immutable launcher modules, then atomically replace each tiny entry.
 * Call while admission is fenced. Old launchers are kept for already-loaded
 * entry modules, whose dependency imports may still be pending.
 */
export async function writeLaunchers(root, packageRoot) {
  const modules = await Promise.all(MODULES.map(async name => [name,
    await readFile(new URL(name, import.meta.url))]));
  const hash = createHash("sha256");
  for (const [name, bytes] of modules) hash.update(name).update(bytes);
  const id = hash.digest("hex");
  const parent = path.join(root, "launchers");
  await managedDirectory(parent, { create: true });
  const directory = path.join(parent, id);
  const staging = await mkdtemp(path.join(parent, ".staging-"));
  try {
    for (const [name, bytes] of modules) await durableFile(path.join(staging, name), bytes);
    await syncDirectory(staging);
    try { await rename(staging, directory); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    await managedDirectory(directory);
    for (const [name, bytes] of modules) {
      const file = path.join(directory, name);
      if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()
        || !(await readFile(file)).equals(bytes)) throw new Error("managed launcher integrity changed");
    }
    await syncDirectory(parent);
  } finally { await rm(staging, { recursive: true, force: true }); }
  const bin = path.join(root, "bin");
  await managedDirectory(bin, { create: true });
  for (const kind of ENTRY_KINDS) {
    const bytes = `#!/usr/bin/env node\nimport { runEntry } from "../launchers/${id}/entry.mjs";\n`
      + `await runEntry(${JSON.stringify({ kind, packageRoot, managerRoot: root, managedRequired: true })});\n`;
    const temporary = path.join(bin, `.${randomUUID()}.tmp`);
    try {
      await durableFile(temporary, bytes, 0o700);
      await rename(temporary, path.join(bin, `${kind}.mjs`));
    } finally { await rm(temporary, { force: true }); }
  }
  await syncDirectory(bin);
  return stablePaths(root);
}
