import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, open, rename, rm, stat, symlink, unlink, writeFile }
  from "node:fs/promises";
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
// guard that compared names rather than identity refused one of them. This runs
// everywhere rather than skipping, so the suite's skip count does not depend on
// which filesystem it lands on: where case is significant the second name names
// nothing, and saying so is a real assertion about that machine.
test("a managed directory reached by another of its own names is not an escape", async t => {
  const { root, paths } = await store(t);
  const { assertManagedDirectory } = await import("../src/safe-directory.mjs");
  const spelled = path.join(root, path.basename(paths.locks).toUpperCase());
  const insensitive = await lstat(spelled).then(found => found.isDirectory(), () => false);

  if (!insensitive) {
    await assert.rejects(assertManagedDirectory(root, spelled), { code: "ENOENT" },
      "this filesystem distinguishes case, so that name must simply not exist");
    return;
  }
  const inspected = await assertManagedDirectory(root, spelled);
  assert.equal(inspected.directory, spelled);
  assert.equal(inspected.stat.isDirectory(), true);
});

/**
 * Inside the store is not the same as where the name says.
 *
 * Judging only containment in the canonical root let a directory be served
 * from somewhere else inside the store: an ancestor replaced by a symlink
 * after it had been checked resolves the rest of the walk into another
 * directory, and both halves of `withRegularNoFollow`'s parent identity check
 * agree with each other because both resolve through the same symlink.
 * Measured at 9 to 11 admissions per 2.5 seconds of this race, each one
 * serving the decoy's directory for the target's path.
 *
 * What a rename cannot change is which directory a segment lives in, so the
 * parent is the thing held fixed: each segment must resolve to a child of the
 * directory the previous segment validated. Sampled for the same reason as the
 * test above - the window is between two calls inside one walk and cannot be
 * interleaved from here - but it cannot fail spuriously: only an admitted
 * redirect fails it, and the run asserts it exercised the race rather than
 * passing on an empty one.
 */
test("an ancestor swapped for a symlink cannot serve another directory in the store",
  async t => {
    const { root } = await store(t);
    const { assertManagedDirectory } = await import("../src/safe-directory.mjs");
    const depth = ["l1", "l2", "l3"];
    const asked = path.join(root, "target");
    const parked = path.join(root, "target.parked");
    const decoy = path.join(root, "decoy");
    for (const base of [asked, decoy]) await mkdir(path.join(base, ...depth), { recursive: true });
    const leaf = path.join(asked, ...depth);
    const decoyLeaf = await stat(path.join(decoy, ...depth));
    const turn = () => new Promise(resolve => { setImmediate(resolve); });

    let flips = 0;
    let churning = true;
    const churn = (async () => {
      while (churning) {
        try {
          await rename(asked, parked);
          await symlink(decoy, asked);
          flips += 1;
          for (let i = 0; i < 6; i += 1) await turn();
          await unlink(asked);
          await rename(parked, asked);
          await new Promise(resolve => { setTimeout(resolve, 2); });
        } catch { /* losing the race against ourselves is expected */ }
      }
    })();

    const counts = { admitted: 0, redirected: 0, absent: 0, escaped: 0, notReal: 0, other: 0 };
    const deadline = Date.now() + 2_500;
    const reader = async () => {
      while (Date.now() < deadline) {
        try {
          const found = await assertManagedDirectory(root, leaf);
          if (found.stat.dev === decoyLeaf.dev && found.stat.ino === decoyLeaf.ino) {
            counts.redirected += 1;
          } else counts.admitted += 1;
        } catch (error) {
          const message = error.message ?? "";
          if (error.code === "ENOENT") counts.absent += 1;
          else if (/escapes the canonical store root/.test(message)) counts.escaped += 1;
          else if (/is not a real directory/.test(message)) counts.notReal += 1;
          else counts.other += 1;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: 16 }, reader));
    } finally {
      churning = false;
      await churn;
    }

    const report = JSON.stringify({ flips, ...counts });
    assert.equal(counts.redirected, 0, `another directory in the store was served: ${report}`);
    assert.ok(flips > 0 && counts.admitted > 0 && counts.notReal > 0,
      `the race never ran, so nothing was proven: ${report}`);
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
