import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function collectFile(source, relative, collected) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`symbolic link inside runtime files: ${relative}`);
  if (stat.isDirectory()) {
    for (const entry of (await readdir(source)).sort()) {
      await collectFile(path.join(source, entry), path.posix.join(relative, entry), collected);
    }
  } else if (stat.isFile()) {
    collected.set(relative, { bytes: await readFile(source), mode: stat.mode & 0o777 });
  } else throw new Error(`unsupported runtime file: ${relative}`);
}

/** This format also names existing generations; keep it stable across upgrades. */
export function fingerprint(files) {
  const hash = createHash("sha256");
  for (const [name, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([name, file.mode, file.bytes.length]));
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}
