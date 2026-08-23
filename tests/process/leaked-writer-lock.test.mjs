import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";
import { withWriterMutex } from "../../packages/storage-filesystem/src/writer-mutex.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * A lock left behind by a process that was killed.
 *
 * Every client puts a timeout on its hooks and kills them when it expires. A
 * hook killed mid-write leaves the writer lock behind with its own pid in it,
 * and reclaiming it required the lock to be *both* dead and a minute old. So one
 * killed hook stopped every write in the workspace for the next sixty seconds:
 * no intent, no claim, no message - and no session could attach.
 *
 * Measured, with a genuinely dead pid and a fresh timestamp: `acc work` failed
 * after 1149ms with "another writer holds the store lock", and a new session
 * took 1147ms to not attach. Hooks fail open, so nothing said so; the session
 * simply never appeared and `acc status` went on reporting the ones that had.
 */
async function locked(t, owner) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-lock-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const paths = { locks: path.join(base, "locks"), tmp: path.join(base, "tmp") };
  await mkdir(paths.locks, { recursive: true });
  await mkdir(paths.tmp, { recursive: true });
  const directory = path.join(paths.locks, "writer.lock");
  await mkdir(directory);
  // The owner record is the file's whole content. Wrapping it in `{ value }`
  // parses, reads as an owner with no pid and no timestamp, and makes the
  // liveness test pass without ever reaching the code it is about.
  await writeFile(path.join(directory, "owner.json"), `${JSON.stringify(owner)}\n`);
  return { base, paths, directory };
}

const clockAt = now => ({ now: () => now });
const NOW = "2026-08-23T12:00:00.000Z";
const held = (pid, acquiredAt) => ({ pid, token: "leaked", acquiredAt });

test("a lock whose holder is gone is taken back at once", async t => {
  const place = await locked(t, held(4242, NOW));

  const result = await withWriterMutex(place.paths,
    { root: place.base, clock: clockAt(NOW), pidIsAlive: () => false, attempts: 3, waitMs: 1 },
    async () => "written");

  assert.equal(result, "written",
    "a workspace stayed unwritable because a killed process still owned the lock");
});

test("a lock whose holder is running is left alone", async t => {
  const place = await locked(t, held(process.pid, NOW));

  const failure = await withWriterMutex(place.paths,
    { root: place.base, clock: clockAt(NOW), pidIsAlive: () => true, attempts: 3, waitMs: 1 },
    async () => "written").then(() => null, error => error);

  // The whole point of the lock. Reclaiming faster must not mean reclaiming
  // from someone who is still writing.
  assert.notEqual(failure, null, "the lock was taken from a live writer");
  assert.equal(failure.code, EXIT.CONFLICT);
});

test("a pid that has been recycled does not hold the lock forever", async t => {
  const place = await locked(t, held(process.pid, "2026-08-23T11:00:00.000Z"));

  // Liveness cannot answer this one: a dead owner's number comes back attached
  // to something unrelated and `pidIsAlive` says yes from then on. An hour is
  // not a write in progress - the hook budget is five seconds.
  const result = await withWriterMutex(place.paths,
    { root: place.base, clock: clockAt(NOW), pidIsAlive: () => true, attempts: 3, waitMs: 1 },
    async () => "written");

  assert.equal(result, "written");
});

/** The same thing through the real binaries, with a pid that is really gone. */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-leak-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const attach = async participant => {
    const child = run(process.execPath, [hook, "codex"],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: participant, cwd: project, source: "startup" }));
    await child;
  };
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project], { env });
  return { base, env, project, attach, cli };
}

/** A pid that existed and does not any more. */
async function departed() {
  const child = run(process.execPath, ["--eval", "0"]);
  const { pid } = child.child;
  await child;
  return pid;
}

test("a session can still attach after a hook was killed holding the lock", async t => {
  const place = await workspace(t);
  await place.attach("first");
  // Materialise, so the writes that follow are the durable ones that take the lock.
  const status = JSON.parse((await place.cli("status", "--json")).stdout).data;
  await place.cli("claim", "--session", status.participants[0].sessionId,
    "--resource", "file:x", "--reason", "editing");

  const workspaces = path.join(place.base, "data", "acc", "workspaces");
  const [workspaceId] = await readdir(workspaces);
  const directory = path.join(workspaces, workspaceId, "locks", "writer.lock");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "owner.json"), `${JSON.stringify({
    pid: await departed(), token: "leaked", acquiredAt: new Date().toISOString(),
  })}\n`);

  await place.attach("second");

  const after = JSON.parse((await place.cli("status", "--json")).stdout).data;
  assert.equal(after.counts.live, 2,
    "the second session never joined, and nothing said so");
});
