import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalManagerRoot } from "./state.mjs";

const contains = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function markedRoots(start) {
  const roots = new Set();
  for (let directory = start;; directory = path.dirname(directory)) {
    if (await exists(path.join(directory, ".git"))) roots.add(directory);
    const config = path.join(directory, "acc.workspace.json");
    if (await exists(config)) {
      roots.add(directory);
      // Installation does not consume workspace config. A malformed optional
      // file cannot prevent an external install, but its marker still counts.
      let declared;
      try { declared = JSON.parse(await readFile(config, "utf8")); } catch { /* Marker only. */ }
      for (const root of Array.isArray(declared?.roots) ? declared.roots : []) {
        if (typeof root === "string") roots.add(await canonicalManagerRoot(path.resolve(directory, root)));
      }
    }
    if (path.dirname(directory) === directory) return roots;
  }
}

/** Read-only admission for installation, independent of Git or workspace stores. */
export async function validateManagedLocation({ managerRoot, dataHome, cwd = process.cwd(), home, env = {} }) {
  const root = await canonicalManagerRoot(managerRoot);
  // The install ledger uses the configured data home, while runtime staging
  // uses the resolved manager. A symlink can put either destination elsewhere.
  dataHome = await canonicalManagerRoot(dataHome ?? path.dirname(path.dirname(managerRoot)));
  const start = await canonicalManagerRoot(env.ACC_WORKSPACE_ROOT || path.resolve(cwd));
  const roots = await markedRoots(dataHome);
  for (const directory of [root, start]) {
    for (const marked of await markedRoots(directory)) roots.add(marked);
  }
  const homes = await Promise.all([home, env.HOME].filter(value => typeof value === "string")
    .map(value => canonicalManagerRoot(path.resolve(value))));
  // HOME and filesystem root are installation launch locations, unless the
  // user explicitly declares them as workspaces or a filesystem marker does.
  if (env.ACC_WORKSPACE_ROOT || !homes.includes(start) && path.dirname(start) !== start) roots.add(start);
  if ([...roots].some(workspace => contains(workspace, dataHome) || contains(workspace, root))) {
    throw new Error("ACC data home must be outside every repository or workspace");
  }
  return root;
}
