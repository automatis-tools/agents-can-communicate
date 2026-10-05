import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { keepVersions } from "../src/own-version.mjs";

/**
 * What survives in a client's versioned plugin cache, and why more than one may.
 *
 * These clients cache a plugin under its version and pin one `installPath` at a
 * time, so an upgrade orphans the directory it moved off. A session already open
 * still holds that path, which is the whole reason this keeps a second version
 * rather than only the one just written.
 */

const io = { readdir, rm };

async function cacheWith(t, names) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-keep-versions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of names) await mkdir(path.join(root, name), { recursive: true });
  return root;
}

test("an upgrade keeps the version it wrote and the one it moved off", async t => {
  const root = await cacheWith(t, ["0.5.6", "0.5.7", "0.5.8"]);

  const removed = await keepVersions({ root, keep: ["0.5.8", "0.5.7"], io });

  assert.deepEqual(removed, ["0.5.6"]);
  assert.deepEqual((await readdir(root)).sort(), ["0.5.7", "0.5.8"]);
});

test("a plain install keeps only the version it wrote", async t => {
  // The list carries a null wherever there is no previous version to hold: a
  // first install, or one the manager pinned to the generation already active.
  const root = await cacheWith(t, ["0.5.6", "0.5.7", "0.5.8"]);

  await keepVersions({ root, keep: ["0.5.8", null], io });

  assert.deepEqual(await readdir(root), ["0.5.8"]);
});

test("naming one version twice does not make it two", async t => {
  const root = await cacheWith(t, ["0.5.7", "0.5.8"]);

  const removed = await keepVersions({ root, keep: ["0.5.8", "0.5.8"], io });

  assert.deepEqual(removed, ["0.5.7"]);
  assert.deepEqual(await readdir(root), ["0.5.8"]);
});

test("a file beside the versions is not a version", async t => {
  // The cache root of a marketplace ACC did not create can hold anything. Only
  // directories are versions of this plugin; nothing else is ours to remove.
  const root = await cacheWith(t, ["0.5.7", "0.5.8"]);
  await writeFile(path.join(root, "README"), "not a version\n");

  await keepVersions({ root, keep: ["0.5.8"], io });

  assert.deepEqual((await readdir(root)).sort(), ["0.5.8", "README"]);
});

// Claude Code marks a cached version with `.in_use/<pid>`, named after a running
// session (2.1.286, 2026-10-05). A reinstall after an update names only the
// active version, so without this it removed a copy the client had marked (#257).
async function markInUse(root, version, pid) {
  await mkdir(path.join(root, version, ".in_use"), { recursive: true });
  await writeFile(path.join(root, version, ".in_use", String(pid)),
    JSON.stringify({ pid, procStart: "Mon Oct  5 02:59:17 2026" }));
}

test("a version a running session marks in use stays", async t => {
  const root = await cacheWith(t, ["0.8.5", "0.9.0"]);
  await markInUse(root, "0.8.5", process.pid);

  const removed = await keepVersions({ root, keep: ["0.9.0", null], io });

  assert.deepEqual(removed, []);
  assert.deepEqual((await readdir(root)).sort(), ["0.8.5", "0.9.0"]);
});

test("a marker whose process has exited holds nothing", async t => {
  const root = await cacheWith(t, ["0.8.5", "0.9.0"]);
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  await markInUse(root, "0.8.5", pid);
  // Its own marker gone, the session leaves an empty directory behind.
  await mkdir(path.join(root, "0.8.4", ".in_use"), { recursive: true });

  const removed = await keepVersions({ root, keep: ["0.9.0", null], io });

  assert.deepEqual(removed.sort(), ["0.8.4", "0.8.5"]);
  assert.deepEqual(await readdir(root), ["0.9.0"]);
});

test("a file in the marker directory that names no pid holds nothing", async t => {
  const root = await cacheWith(t, ["0.8.5", "0.9.0"]);
  await mkdir(path.join(root, "0.8.5", ".in_use"), { recursive: true });
  await writeFile(path.join(root, "0.8.5", ".in_use", "README"), "not a pid\n");

  assert.deepEqual(await keepVersions({ root, keep: ["0.9.0", null], io }), ["0.8.5"]);
});

test("a cache directory that is not there yet removes nothing", async t => {
  const root = await cacheWith(t, []);

  const removed = await keepVersions({ root: path.join(root, "absent"), keep: ["0.5.8"], io });

  assert.deepEqual(removed, []);
});
