import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { flushesDuring } from "../../../tests/helpers/flush-recorder.mjs";

const { storePaths } = await import("../src/index.mjs");
const { withWriterMutex } = await import("../src/writer-mutex.mjs");

// The writer lock guards live processes, and a crash of the machine leaves none:
// whatever the lock directory holds afterwards guards nobody. Taking it used to
// flush the owner record, and on POSIX the candidate's directory and the locks
// directory too - three flushes per acquisition, five acquisitions in a session
// start. On windows-latest one flush took 15 ms at the median and up to 5.8 s
// beside the suite, and the hooks that ran past their budget spent most of it
// flushing (2026-10-01). Nothing is flushed now. The one thing the flush
// prevented - an owner record a crash left unreadable - is reclaimed like a dead
// owner once it is older than any write takes.
const clock = { now: () => new Date().toISOString() };

async function lockRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-owner-flush-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = storePaths(root);
  await mkdir(paths.locks, { recursive: true });
  return { root, paths };
}

for (const platform of ["win32", "linux"]) {
  test(`${platform}: taking the writer lock flushes nothing`,
    { skip: platform !== "win32" && process.platform === "win32"
      && "a POSIX lock renames over an empty directory, which Windows refuses" },
    async t => {
      const { root, paths } = await lockRoot(t);
      const flushed = await flushesDuring(() => withWriterMutex(paths,
        { root, clock, platform }, async () => {}));
      assert.deepEqual(flushed, []);
    });
}

// What a crash leaves: the lock directory with an owner record whose bytes
// never reached the disk - empty, or zeros where NTFS kept the length.
async function crashedLock(paths, ageMs) {
  const lock = path.join(paths.locks, "writer.lock");
  await mkdir(lock);
  const owner = path.join(lock, "owner.json");
  await writeFile(owner, Buffer.alloc(96));
  const then = new Date(Date.now() - ageMs);
  await utimes(owner, then, then);
  return lock;
}

test("an owner record a crash left unreadable is reclaimed once it is older than any write",
  async t => {
    const { root, paths } = await lockRoot(t);
    await crashedLock(paths, 120_000);
    let ran = false;
    await withWriterMutex(paths, { root, clock, acquireTimeoutMs: 1_000 }, async () => { ran = true; });
    assert.equal(ran, true);
  });

test("an unreadable owner record younger than that is waited for, never taken",
  async t => {
    const { root, paths } = await lockRoot(t);
    const lock = await crashedLock(paths, 0);
    await assert.rejects(withWriterMutex(paths, { root, clock, acquireTimeoutMs: 200 },
      async () => { throw new Error("the lock was taken from under an owner still writing"); }),
    { message: /another writer holds the store lock/ });
    assert.deepEqual((await import("node:fs")).readdirSync(lock), ["owner.json"]);
  });
