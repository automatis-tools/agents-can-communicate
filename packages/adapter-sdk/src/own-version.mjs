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

/**
 * Leave one copy of a versioned plugin, the one just written.
 *
 * These clients cache a plugin under its version. Until the version tracked the
 * package it never changed, every install landed in the same directory and
 * overwrote itself, and nothing accumulated. Once it started moving, the first
 * upgrade left three copies of ACC in a home that should hold one.
 *
 * Scoped to the plugin's own directory. The marketplace cache root above it
 * holds every plugin installed from that marketplace, and removing that root
 * once took a plugin the user had installed themselves - so a sibling here is
 * an older ACC, and a sibling one level up is somebody else's.
 */
export async function keepOnlyVersion({ root, version, io }) {
  const entries = await io.readdir(root, { withFileTypes: true }).catch(() => []);
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === version) continue;
    await io.rm(path.join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
