import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The version of the ACC that is running.
 *
 * Every plugin manifest used to carry its own version literal, updated by hand
 * and by nobody: three releases after 0.1.6 the package was 0.1.9 while every
 * client had cached, listed and reported 0.1.6. That is not cosmetic - the
 * version string is how a client decides whether its cached copy is current, so
 * a bundle whose version never changes is one it has no reason to replace.
 *
 * Read by walking up for the nearest `package.json`, which lands on the calling
 * package in a checkout and on the same file once bundled, where every package
 * is versioned together. Answers `0.0.0` rather than throwing: an install that
 * cannot read its own version should still lay a plugin down, under a version
 * that is visibly wrong rather than crash.
 */
export async function ownVersion(fromUrl) {
  let directory = path.dirname(fileURLToPath(fromUrl));
  for (;;) {
    const candidate = path.join(directory, "package.json");
    const text = await readFile(candidate, "utf8").catch(() => null);
    if (text !== null) {
      try {
        const version = JSON.parse(text).version;
        if (typeof version === "string" && version !== "") return version;
      } catch {
        // A manifest that will not parse is not this package's version.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return "0.0.0";
    directory = parent;
  }
}

/**
 * Stamp a laid-out plugin manifest with the version that wrote it.
 *
 * The shipped manifest carries no version of its own, so there is nothing in the
 * repository to fall out of step. Best-effort: a manifest that is not there was
 * not ours to stamp.
 */
export async function stampPluginVersion({ file, version, io }) {
  const text = await io.readFile(file, "utf8").catch(() => null);
  if (text === null) return false;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return false;
  }
  await io.writeFile(file, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  return true;
}
