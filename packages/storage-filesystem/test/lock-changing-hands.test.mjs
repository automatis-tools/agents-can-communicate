import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { storePaths } from "../src/index.mjs";
import { withWriterMutex } from "../src/writer-mutex.mjs";

/**
 * A lock changing hands is not an attack.
 *
 * Reads inside the store are guarded against a directory being swapped between
 * the check and the open - stat the parent, open with `O_NOFOLLOW`, stat the
 * parent again, refuse if its identity changed. That is right for a record: a
 * state file's parent has no business being replaced while it is read.
 *
 * The writer lock is the one directory in the store whose whole life is being
 * created and removed. `mkdir` is the atomic primitive that grants it and `rm`
 * is how it is released, so its inode changes every time the lock passes from
 * one process to the next. The owner file lives inside it and is read through
 * the same strict path, so a contended lock produced:
 *
 *   record parent directory changed while opening
 *
 * and the command failed outright. Seen on Linux CI with four agents attaching
 * to a fresh workspace at once - the ordinary way two people start work - and
 * not reproducible on macOS in twelve rounds of six, which is why it reached a
 * release.
 *
 * The guard stays. What changes is the reading of it here: the lock's identity
 * changing under a read means the lock moved, which is the thing this loop is
 * already written to handle.
 */
async function store(t) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = storePaths(root);
  await mkdir(paths.locks, { recursive: true });
  await mkdir(paths.tmp, { recursive: true });
  return { root, paths };
}

const clock = { now: () => new Date().toISOString() };

test("a contender lets a healthy writer finish before giving up", async t => {
  const { root, paths } = await store(t);
  let holderReady;
  let releaseHolder;
  const ready = new Promise(resolve => { holderReady = resolve; });
  const release = new Promise(resolve => { releaseHolder = resolve; });
  const holder = withWriterMutex(paths, { root, clock }, async () => {
    holderReady();
    await release;
  });
  await ready;

  // One attach now performs several short writes under this shared mutex. A
  // busy process can therefore hold the queue for longer than the old one
  // second window while still remaining comfortably inside the hook budget.
  const timer = setTimeout(releaseHolder, 1_200);
  try {
    const result = await withWriterMutex(paths, { root, clock }, async () => "written");
    assert.equal(result, "written");
  } finally {
    clearTimeout(timer);
    releaseHolder();
    await holder;
  }
});

test("a live holder cannot keep a contender past the hook-safe deadline", async t => {
  const { root, paths } = await store(t);
  let holderReady;
  let releaseHolder;
  const ready = new Promise(resolve => { holderReady = resolve; });
  const release = new Promise(resolve => { releaseHolder = resolve; });
  const holder = withWriterMutex(paths, { root, clock }, async () => {
    holderReady();
    await release;
  });
  await ready;

  let elapsed = 0;
  let operationRan = false;
  try {
    const failure = await withWriterMutex(paths, {
      root,
      clock,
      monotonicNow: () => { elapsed += 7; return elapsed; },
      sleep: async duration => { elapsed += duration; },
    }, async () => { operationRan = true; }).then(() => null, error => error);

    assert.equal(failure?.code, EXIT.CONFLICT);
    assert.equal(operationRan, false);
    assert.ok(elapsed > 1_200, `the contender gave up too early after ${elapsed}ms`);
    assert.ok(elapsed <= 3_000,
      `lock acquisition consumed ${elapsed}ms of the five-second hook budget`);
  } finally {
    releaseHolder();
    await holder;
  }
});

test("the lock passing to another holder mid-read is not fatal", async t => {
  // The interleaving Linux CI hit, made deterministic: the owner file is opened,
  // and before the parent is checked again the lock is released and taken by
  // somebody else - so the directory the reader checked is not the directory it
  // read from. That is exactly what the guard is built to catch, and exactly
  // what an ordinary handover looks like.
  const { root, paths } = await store(t);
  const directory = path.join(paths.locks, "writer.lock");

  await mkdir(directory);
  await writeFile(path.join(directory, "owner.json"),
    JSON.stringify({ pid: 999999, token: "other", acquiredAt: clock.now() }));

  let swapped = false;
  const handover = async (...args) => {
    const handle = await open(...args);
    if (!swapped) {
      swapped = true;
      // Released by its holder, then taken again: same path, new inode. The new
      // holder finishes shortly after, so the loop has something to win once it
      // has survived the handover.
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory);
      setTimeout(() => { rm(directory, { recursive: true, force: true }).catch(() => {}); }, 10);
    }
    return handle;
  };

  let ran = false;
  await withWriterMutex(paths,
    { root, clock, attempts: 400, waitMs: 1, pidIsAlive: () => true, openFile: handover },
    async () => { ran = true; });

  assert.equal(swapped, true, "the handover never happened, so nothing was proven");
  assert.equal(ran, true, "a lock changing hands stopped the writer");
});

test("a directory swapped under the owner read is retried, not fatal", async t => {
  const { root, paths } = await store(t);
  const directory = path.join(paths.locks, "writer.lock");

  // Hold the lock as somebody else, so the acquiring loop has to read the owner
  // - and swap the directory identity exactly once while it does.
  await mkdir(directory);
  await writeFile(path.join(directory, "owner.json"),
    JSON.stringify({ pid: 999999, token: "other", acquiredAt: clock.now() }));
  setTimeout(() => {
    rm(directory, { recursive: true, force: true }).catch(() => {});
  }, 5);

  let ran = false;
  await withWriterMutex(paths, { root, clock, attempts: 200, waitMs: 1,
    pidIsAlive: () => true }, async () => { ran = true; });

  assert.equal(ran, true);
});

/**
 * A lock moving is not an escape either.
 *
 * The same guard judges *where* a managed directory is, by comparing what
 * realpath answers against the canonical store root. It used to demand the
 * exact path it asked about. On Darwin realpath resolves by opening the path
 * and asking the kernel for that vnode's current path, so a directory renamed
 * in between answers under its new name - and this lock is renamed for a
 * living: takeStaleOwnership moves it to writer.reclaimed-<hash>.lock,
 * releaseCanonical to writer.released-<hash>.lock, and a candidate is renamed
 * onto it to acquire it. Both names are inside paths.locks, so nothing has
 * escaped anything; the read failed with "managed directory escapes the
 * canonical store root" and took the whole write down with it.
 *
 * Sampled, because the window is between two steps inside one libc call and
 * cannot be interleaved from here: about one read in a thousand on this
 * machine, none at all on Linux, whose realpath resolves lexically. It is
 * bounded by iterations and by wall time so a slow machine pays no more than
 * a fast one, and it cannot fail spuriously - only an escape verdict fails it.
 */
test("a lock renamed aside under an owner read is a move, not an escape", async t => {
  const { root, paths } = await store(t);
  const { readJsonIfPresent } = await import("../src/atomic-json.mjs");
  const directory = path.join(paths.locks, "writer.lock");
  const aside = path.join(paths.locks, "writer.reclaimed-fixture.lock");
  const owner = path.join(directory, "owner.json");
  await mkdir(directory);
  await writeFile(owner, JSON.stringify({ pid: 999999, token: "other", acquiredAt: clock.now() }));

  let churning = true;
  const churn = (async () => {
    while (churning) {
      await rename(directory, aside).catch(() => null);
      await rename(aside, directory).catch(() => null);
    }
  })();

  const counts = { read: 0, absent: 0, moved: 0, escaped: 0 };
  let sample = null;
  const deadline = Date.now() + 3_000;
  try {
    for (let attempt = 0; attempt < 20_000 && Date.now() < deadline; attempt += 1) {
      try {
        if (await readJsonIfPresent(owner, root) === null) counts.absent += 1;
        else counts.read += 1;
      } catch (error) {
        if (/escapes the canonical store root/.test(error.message)) {
          counts.escaped += 1;
          sample ??= error.details;
        } else if (/parent directory changed/.test(error.message)) counts.moved += 1;
        else throw error;
      }
    }
  } finally {
    churning = false;
    await churn;
  }

  assert.ok(counts.read + counts.absent > 0, `the read loop never ran: ${JSON.stringify(counts)}`);
  assert.equal(counts.escaped, 0,
    `a rename inside the store was called an escape: ${JSON.stringify({ counts, sample })}`);
});

// The same rule seen without a race: where the filesystem keeps one directory
// under names that differ only in case, both names are that directory, and the
// guard that compares names rather than locations refused one of them.
test("a managed directory reached by another of its own names is not an escape", async t => {
  const { root, paths } = await store(t);
  const { assertManagedDirectory } = await import("../src/safe-directory.mjs");
  const spelled = path.join(root, path.basename(paths.locks).toUpperCase());
  const insensitive = await lstat(spelled).then(found => found.isDirectory(), () => false);
  if (!insensitive) {
    t.skip("this filesystem distinguishes case, so the directory has only one name");
    return;
  }

  const inspected = await assertManagedDirectory(root, spelled);
  assert.equal(inspected.directory, spelled);
  assert.equal(inspected.stat.isDirectory(), true);
});

test("the guard still refuses a record whose parent was swapped", async t => {
  // The protection this is scoped away from must remain everywhere else.
  const { root } = await store(t);
  const { readRegularNoFollow } = await import("../src/safe-file.mjs");
  const directory = path.join(root, "state");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "record.json");
  await writeFile(file, "{}");

  const swapping = async (...args) => {
    const { open } = await import("node:fs/promises");
    const handle = await open(...args);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    return handle;
  };

  await assert.rejects(readRegularNoFollow(file, root, swapping),
    /parent directory changed/);
});
