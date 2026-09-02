import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

/** Full filesystem topology below root, suitable for byte-for-byte restore gates. */
export async function treeSnapshot(root) {
  const snapshot = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await lstat(absolute);
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) snapshot.push({ path: relative, type: "directory", mode });
    else if (stat.isFile()) snapshot.push({ path: relative, type: "file", mode,
      bytes: (await readFile(absolute)).toString("base64") });
    else if (stat.isSymbolicLink()) snapshot.push({ path: relative, type: "symlink", mode,
      target: await readlink(absolute) });
    else throw new Error(`unsupported filesystem entry type at ${absolute}`);
  }
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}
