// The version of ACC's Codex hooks plugin moves only when its files do.
//
// Codex trusts a plugin's hooks against a hash of the whole cached plugin
// directory, manifest included (codex-rs/hooks/src/engine/plugin_fingerprint.rs,
// 0.167.1), and checks that hash again before every hook runs. While each ACC
// release stamped its own version into the one plugin that held the hooks, every
// release changed that hash: after an update Codex marked all five ACC hooks
// "modified since last trusted" and ran none of them until a person trusted
// them again. Measured from 0.14.1 to 0.15.0 - the stamped version was the only
// byte that differed, and Codex's algorithm over the two copies gives exactly the
// two hashes Codex recorded.
//
// So the copy Codex runs keeps the version it already has when the files it
// would hold are byte for byte the same. A changed hook list or hook shim is a
// changed plugin: it gets the running ACC's version, and Codex asks for trust
// again, as it should.
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { compareVersionOrder, keepVersions, stampPluginVersion, versionOrder }
  from "@agents-can-communicate/adapter-sdk";

const compareVersions = (left, right) => {
  const order = compareVersionOrder(versionOrder(left), versionOrder(right));
  return order !== 0 ? order : left < right ? -1 : left > right ? 1 : 0;
};

/** The copy Codex runs: of the version directories present, the highest. */
export function activeVersion(names) {
  return names.toSorted(compareVersions).at(-1) ?? null;
}

// Every entry under a root, in a stable order; null when it cannot be read.
async function listTree(root) {
  const entries = [];
  const walk = async relative => {
    const found = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of found.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push({ name, kind: "directory" });
        await walk(name);
      } else {
        entries.push({ name, kind: entry.isFile() ? "file" : "other" });
      }
    }
  };
  try {
    await walk("");
  } catch {
    return null;
  }
  return entries;
}

/** Whether two trees hold the same names and the same bytes. */
export async function sameTree(left, right) {
  const [a, b] = await Promise.all([listTree(left), listTree(right)]);
  if (a === null || b === null || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].name !== b[index].name || a[index].kind !== b[index].kind) return false;
    if (a[index].kind === "other") return false;
    if (a[index].kind === "file") {
      const [x, y] = await Promise.all([readFile(path.join(left, a[index].name)),
        readFile(path.join(right, b[index].name))]);
      if (!x.equals(y)) return false;
    }
  }
  return true;
}

const io = { readFile, writeFile, readdir, rm };
const stamp = (source, version) =>
  stampPluginVersion({ file: path.join(source, ".codex-plugin", "plugin.json"), version, io });

/**
 * Stamp the laid-out hooks plugin and put the copy Codex runs in place.
 *
 * `source` is the marketplace copy just written, without a version. Codex reads
 * the version from it and replaces its cached copy whenever the two disagree, so
 * both always carry the same one. Returns the version settled on and whether the
 * cached copy changed.
 *
 * Nothing is removed when nothing changed. When the copy changes, the one it
 * replaces stays beside it: a session open across the update was trusted
 * against that copy's hash and keeps running its hooks until it ends.
 */
export async function settleHooksPlugin({ source, cacheDir, version }) {
  const present = (await readdir(cacheDir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const active = activeVersion(present);
  if (active !== null) {
    await stamp(source, active);
    if (await sameTree(source, path.join(cacheDir, active))) return { version: active, changed: false };
  }
  await stamp(source, version);
  const cached = path.join(cacheDir, version);
  await rm(cached, { recursive: true, force: true });
  await cp(source, cached, { recursive: true });
  await keepVersions({ root: cacheDir, keep: [version, active], io });
  return { version, changed: true };
}
