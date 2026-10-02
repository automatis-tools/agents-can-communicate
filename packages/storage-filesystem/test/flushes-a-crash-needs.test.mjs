import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createId, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { flushesDuring } from "./flush-recorder.mjs";

const { publishAtomic } = await import("../src/atomic-json.mjs");
const { openFilesystemStore, storePaths } = await import("../src/store.mjs");
const { sweepIfDue } = await import("../src/stage-sweep.mjs");

// A flush is paid only for what a crash of the machine would otherwise lose.
// Measured on windows-latest (2026-10-01, three full suites at once): the two
// hooks that ran past their five-second budget spent 72-78% of it in flushes.
// A Windows flush waits for the whole disk, and a 4 KB flush beside the suite
// took 15 ms at the median and up to 5.8 s with the CPU idle. Whatever a crash
// cannot hurt is written without one:
// - the retained copy of an accepted write, which the sweep discards;
// - a record whose reader treats damage as absence, written with no flush;
// - a record that may come back as its previous version: its bytes are
//   flushed, so it is never torn, and its name is left to the next flush.
const WORKSPACE = "workspace_flush";
const inside = (directory, file) => file === directory || file.startsWith(`${directory}${path.sep}`);

async function scratch(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-flush-needs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the retained copy of an accepted write is never flushed", async t => {
  const root = await scratch(t);
  await mkdir(path.join(root, "events"));
  const flushed = await flushesDuring(() => publishAtomic(path.join(root, "events", "a.json"),
    Buffer.from("{}\n"), { root, tmpDir: path.join(root, "tmp") }));
  assert.notDeepEqual(flushed, [], "the accepted write itself was not flushed");
  assert.deepEqual(flushed.filter(file => inside(path.join(root, "stage"), file)), []);
});

test("a record whose reader treats damage as absence is written without a flush", async t => {
  const root = await scratch(t);
  const flushed = await flushesDuring(() => publishAtomic(path.join(root, "marker.json"),
    Buffer.from("{}\n"), { root, tmpDir: path.join(root, "tmp"), replace: true, durability: "none" }));
  assert.deepEqual(flushed, []);
});

test("a record that may come back as its previous version flushes its bytes, never its name",
  async t => {
    const root = await scratch(t);
    const flushed = await flushesDuring(() => publishAtomic(path.join(root, "record.json"),
      Buffer.from("{}\n"), { root, tmpDir: path.join(root, "tmp"), replace: true,
        durability: "bytes" }));
    assert.equal(flushed.length, 1, `flushed ${JSON.stringify(flushed)}`);
    assert.equal(inside(path.join(root, "tmp"), flushed[0]), true, "the flush was not of the bytes");
  });

test("an ephemeral record costs one flush, of its bytes", async t => {
  const root = await scratch(t);
  const store = await openFilesystemStore({ root, workspaceId: WORKSPACE,
    clock: { now: () => new Date().toISOString() }, ids: { next: kind => createId(kind) } });
  const record = { schemaVersion: SCHEMA_VERSION, participantId: "participant_a",
    workspaceId: WORKSPACE, displayName: "a", kind: "agent", createdAt: "2026-10-01T00:00:00.000Z" };
  const flushed = await flushesDuring(() => store.ephemeral.put("participant", "participant_a", record));
  assert.equal(flushed.length, 1, `flushed ${JSON.stringify(flushed)}`);
  assert.equal(inside(storePaths(root).tmp, flushed[0]), true, "the flush was not of the bytes");
});

test("the sweep records its pass without a flush", async t => {
  const root = await scratch(t);
  const paths = storePaths(root);
  await mkdir(paths.locks, { recursive: true });
  const flushed = await flushesDuring(() => sweepIfDue(paths,
    { root, clock: { now: () => new Date().toISOString() } }));
  // The marker lives in locks/ and is written through tmp/.
  assert.deepEqual(flushed.filter(file => inside(paths.locks, file) || inside(paths.tmp, file)), []);
});

// A journalled transaction: its entry, the pointer opening it, each record it
// publishes and the pointer going idle. The entry's name is made durable by the
// pointer's publication beside it in journal/: POSIX syncs that directory, and
// on Windows a flush commits NTFS's metadata journal up to that file's last
// change, every earlier rename included. On Windows each later flush likewise
// commits the rename before it, so only bytes are flushed there; a crash that
// loses the last rename leaves the transaction open, and rolling it forward
// again changes nothing. No completion marker is written: the reclaimer, which
// runs under the writer lock, retires every entry but the open one.
test("a journalled transaction flushes the bytes it publishes, and names only where they need it",
  async t => {
    const root = await scratch(t);
    const paths = storePaths(root);
    const store = await openFilesystemStore({ root, workspaceId: WORKSPACE,
      clock: { now: () => new Date().toISOString() }, ids: { next: kind => createId(kind) } });
    const now = new Date().toISOString();
    const flushed = await flushesDuring(() => store.transaction(tx => {
      tx.put("workspace", WORKSPACE, { schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE,
        displayName: "a", source: "directory", roots: [root], createdAt: now });
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: createId("event"), workspaceId: WORKSPACE,
        actorSessionId: "session_a", type: "workspace.materialised", occurredAt: now, payload: {} });
    }, { kinds: ["workspace"] }));
    // Entry, open, two records, idle: bytes each, plus every name on POSIX
    // except the entry's.
    const expected = process.platform === "win32" ? 5 : 9;
    assert.equal(flushed.length, expected, `flushed ${JSON.stringify(flushed)}`);
    assert.deepEqual(await readdir(path.join(paths.retained, "journal")).catch(() => []), [],
      "a completion marker was written");
  });
