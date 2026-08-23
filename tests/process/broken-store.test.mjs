import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * The command you run when something is wrong has to run when something is
 * wrong.
 *
 * A single truncated record - a writer killed mid-publish, a bad sector - made
 * `acc status`, `acc sync` and `acc doctor` all answer "invalid JSON record",
 * naming nothing. The diagnosis had already found the file and put it in a list:
 * `inspect` walks every record and collects the unreadable ones, and `doctor`
 * asked `collectStatus` for the roster before looking at that list, so the read
 * threw and took the diagnosis with it.
 *
 * Hooks fail open, which is right, and means the failure is silent from the
 * agents' side: coordination simply stops.
 */
async function broken(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-broken-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project], { env });

  for (const participant of ["writer", "reader"]) {
    const child = run(process.execPath, [hook, "codex"],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: participant, cwd: project, source: "startup" }));
    await child;
  }
  const status = JSON.parse((await cli("status", "--json")).stdout).data;
  await cli("message", "--session", status.participants[0].sessionId,
    "--to", "reader", "--subject", "hello", "--body", "world");

  const workspaces = path.join(base, "data", "acc", "workspaces");
  const [workspaceId] = await readdir(workspaces);
  const messages = path.join(workspaces, workspaceId, "state", "message");
  const [name] = await readdir(messages);
  const file = path.join(messages, name);
  await writeFile(file, '{ "truncated');
  return { base, project, env, cli, file, workspaceRoot: path.join(workspaces, workspaceId) };
}

test("doctor answers on the store it exists to describe", async t => {
  const place = await broken(t);

  const failure = await place.cli("doctor").then(() => null, error => error);

  assert.notEqual(failure, null, "a corrupt store was reported healthy");
  assert.equal(failure.code, EXIT.DATA);
  // Naming the file is the whole job. "invalid JSON record" sent a reader
  // looking through a workspace for something the error already knew.
  assert.match(failure.stderr, /repair is blocked/);
  assert.match(failure.stderr, new RegExp(place.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("doctor in machine mode carries the diagnosis, not just the failure", async t => {
  const place = await broken(t);

  const failure = await place.cli("doctor", "--json").then(() => null, error => error);

  const body = JSON.parse(failure.stdout);
  assert.equal(body.ok, false);
  assert.deepEqual(body.error.details.store.corrupt, [place.file]);
  // Adapters do not need the store, so their half of the report survives.
  assert.equal(Array.isArray(body.error.details.adapters), true);
});

test("a read that cannot parse a record says which record", async t => {
  const place = await broken(t);

  const failure = await place.cli("status").then(() => null, error => error);

  assert.match(failure.stderr, /invalid JSON record: /);
  assert.match(failure.stderr, new RegExp(place.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a hook still refuses to be the reason a session stops", async t => {
  const place = await broken(t);

  const child = run(process.execPath, [hook, "codex"],
    { env: { ...place.env, ACC_PARTICIPANT: "reader" } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse",
    session_id: "reader", cwd: place.project, tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: a.mjs\n@@\n-a\n+b\n"
      + "*** End Patch" } }));

  // Failing open on a store nobody can read is the right answer and the reason
  // the failure is invisible from inside a session. Doctor is where it shows.
  const { stdout } = await child;
  assert.equal(stdout, "");
});

test("no directory is created that nothing ever writes to", async t => {
  const place = await broken(t);

  const areas = await readdir(place.workspaceRoot);

  // A `quarantine` area was created in every workspace and written to by
  // nothing: repair refuses to move a corrupt record, so nothing ever had a
  // reason to put one aside. An empty directory that reads as a feature is the
  // same mistake as an attention kind with no rule behind it.
  assert.equal(areas.includes("quarantine"), false,
    "an area exists that no code path writes to");
});
