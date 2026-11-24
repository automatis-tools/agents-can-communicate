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

const octal = mode => mode.toString(8);

/**
 * What differs between two snapshots, one line per entry, in path order.
 *
 * A failed byte-for-byte restore gate used to say only that something differed,
 * which left an intermittent failure with nothing to investigate (#442). Each
 * line names the path, its type and which property changed; file bytes are
 * never printed.
 */
export function snapshotDifferences(before, after) {
  const earlier = new Map(before.map(entry => [entry.path, entry]));
  const later = new Map(after.map(entry => [entry.path, entry]));
  const paths = [...new Set([...earlier.keys(), ...later.keys()])]
    .sort((left, right) => left.localeCompare(right));
  const lines = [];
  for (const file of paths) {
    const was = earlier.get(file);
    const is = later.get(file);
    if (was === undefined) { lines.push(`added ${is.type} ${file}`); continue; }
    if (is === undefined) { lines.push(`removed ${was.type} ${file}`); continue; }
    if (was.type !== is.type) { lines.push(`changed ${file}: ${was.type} -> ${is.type}`); continue; }
    if (was.mode !== is.mode) lines.push(`changed ${is.type} ${file}: mode ${octal(was.mode)} -> ${octal(is.mode)}`);
    if (was.bytes !== is.bytes) lines.push(`changed ${is.type} ${file}: bytes`);
    if (was.target !== is.target) lines.push(`changed ${is.type} ${file}: target`);
  }
  return lines;
}
