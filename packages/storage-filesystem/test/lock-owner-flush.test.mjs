import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Measured on windows-latest: a flush costs about 8 ms there, and a hook takes
// the writer lock several times. Taking it wrote the owner record, flushed it,
// and then flushed the same file again as the record's directory entry. On NTFS
// flushing a file commits the metadata journal up to the file's last change,
// which includes its creation (docs/design/2026-09-30-native-windows-support.md,
// "Directory sync"), so the first flush already made the entry durable. POSIX
// still syncs the candidate directory: a file's fsync does not cover its name.
const opens = [];
const original = fs.promises.open;
fs.promises.open = async (file, flags, ...rest) => {
  opens.push([String(file), flags]);
  return original(file, flags, ...rest);
};
syncBuiltinESMExports();
const { storePaths } = await import("../src/index.mjs");
const { withWriterMutex } = await import("../src/writer-mutex.mjs");

async function acquire(t, platform) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-owner-flush-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = storePaths(root);
  await mkdir(paths.locks, { recursive: true });
  opens.length = 0;
  await withWriterMutex(paths, { root, clock: { now: () => new Date().toISOString() }, platform },
    async () => {});
  return opens.filter(([file]) => path.basename(file) === "owner.json" || file.endsWith(".lock"));
}

test("windows: taking the writer lock flushes its owner record once", async t => {
  const flushes = (await acquire(t, "win32")).filter(([, flags]) => flags === "r+");
  assert.deepEqual(flushes, [], "the owner record was flushed a second time");
});

test("posix: taking the writer lock still syncs the candidate's directory", async t => {
  const directories = (await acquire(t, "linux")).filter(([file]) => file.endsWith(".lock"));
  assert.equal(directories.length > 0, true, "the candidate directory was not synced");
});
