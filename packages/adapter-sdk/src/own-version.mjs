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
 * Leave the named copies of a versioned plugin and remove the rest.
 *
 * These clients cache a plugin under its version. Until the version tracked the
 * package it never changed, every install landed in the same directory and
 * overwrote itself, and nothing accumulated. Once it started moving, the first
 * upgrade left three copies of ACC in a home that should hold one.
 *
 * `keep` is a list rather than the single version just written, because these
 * clients pin one `installPath` per plugin and a session reads it once. A
 * session already open when an upgrade lands still holds the path it started
 * with, so an upgrade names the version it moved off as well as the one it
 * wrote, and that session keeps firing hooks until it is restarted. An install
 * with nothing to hold passes a null, which is dropped here.
 *
 * Scoped to the plugin's own directory. The marketplace cache root above it
 * holds every plugin installed from that marketplace, and removing that root
 * once took a plugin the user had installed themselves - so a sibling here is
 * an older ACC, and a sibling one level up is somebody else's.
 *
 * A version a running session marks in use stays whatever `keep` says. Claude
 * Code puts `.in_use/<pid>`, named after a running session, into a cached
 * version and drops the file when that session exits (2.1.286). A reinstall
 * after an update names only the active version, so it removed a copy the
 * client had marked (#257). A marker whose process has exited holds nothing; a
 * reused pid at worst keeps a copy until the next install.
 */
const IN_USE = ".in_use";
const PID = /^[1-9]\d*$/;

// `kill(pid, 0)` delivers nothing; EPERM means the process exists under another user.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function markedInUse(directory, io, alive) {
  const markers = await io.readdir(path.join(directory, IN_USE)).catch(() => []);
  return markers.some(name => PID.test(name) && alive(Number(name)));
}

export async function keepVersions({ root, keep, io, alive = processAlive }) {
  const wanted = new Set(keep.filter(version => typeof version === "string" && version !== ""));
  const entries = await io.readdir(root, { withFileTypes: true }).catch(() => []);
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || wanted.has(entry.name)) continue;
    if (await markedInUse(path.join(root, entry.name), io, alive)) continue;
    await io.rm(path.join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
