import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
 * A cursor that is not a cursor.
 *
 * `eventsSince` compares sequences as strings, so anything sorting after
 * `9999999999999999` means "nothing has happened since". `not-a-cursor` does,
 * and answered "nothing new" every time it was passed - for as long as it was
 * held. An adapter with a corrupt stored cursor, or an agent that invented one,
 * saw a quiet workspace rather than a mistake.
 *
 * `"0000000000000001; DROP"` was quietly taken as the sequence it starts with,
 * which is the other half of the same silence: input nobody checked, answered
 * with something plausible.
 */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cursor-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const child = run(process.execPath, [hook, "codex"],
    { env: { ...env, ACC_PARTICIPANT: "worker" } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
    session_id: "worker", cwd: project, source: "startup" }));
  await child;
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project, "--json"],
    { env });
  await cli("claim", "--resource", "file:x", "--reason", "editing");
  const session = JSON.parse((await cli("status")).stdout).data.participants[0].sessionId;
  const syncFrom = cursor => cli("sync", "--session", session,
    ...(cursor === undefined ? [] : ["--cursor", cursor]));
  return { project, env, cli, session, syncFrom };
}

for (const cursor of ["not-a-cursor", "-1", "0000000000000001; DROP", "1", "00000000000000001"]) {
  test(`a cursor of ${JSON.stringify(cursor)} is refused, not answered with silence`, async t => {
    const place = await workspace(t);

    const refused = await place.syncFrom(cursor).then(() => null, error => error);

    assert.notEqual(refused, null, `${cursor} was accepted and reported an empty workspace`);
    assert.equal(refused.code, EXIT.USAGE);
    assert.match(JSON.parse(refused.stdout).error.message, /16-digit sequence/);
  });
}

test("the cursor a sync returns is one it will take back", async t => {
  const place = await workspace(t);
  const { cursor } = JSON.parse((await place.syncFrom()).stdout).data;

  const { stdout } = await place.syncFrom(cursor);

  // The round trip is the whole contract: whatever `sync` hands out has to be
  // accepted, or the validation would break the callers it exists to protect.
  assert.equal(JSON.parse(stdout).ok, true);
  assert.deepEqual(JSON.parse(stdout).data.events, []);
});

test("no cursor means from the beginning", async t => {
  const place = await workspace(t);

  const { stdout } = await place.syncFrom();

  assert.equal(JSON.parse(stdout).data.events.length > 0, true);
});

test("a turn still works, because that is where cursors actually come from", async t => {
  const place = await workspace(t);
  const child = run(process.execPath, [hook, "codex"],
    { env: { ...place.env, ACC_PARTICIPANT: "worker" } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit",
    session_id: "worker", cwd: place.project, prompt: "go" }));

  await child;
});
