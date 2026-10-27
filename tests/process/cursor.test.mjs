import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

import { fixtureOwnerEnv } from "../helpers/fixture-owner.mjs";
import { processFixtureEnv } from "../helpers/process-env.mjs";

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
  const env = await processFixtureEnv(base);
  const child = run(process.execPath, [hook, "codex"],
    { env: { ...env, ACC_PARTICIPANT: "worker" } });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
    session_id: "worker", cwd: project, source: "startup" }));
  await child;
  const cli = async (...argv) => run(process.execPath, [acc, ...argv, "--cwd", project, "--json"],
    { env: { ...env, ...await fixtureOwnerEnv(env.ACC_DATA_HOME, "worker") } });
  await cli("claim", "--resource", "file:x", "--reason", "editing");
  const session = JSON.parse((await cli("status")).stdout).data.participants[0].sessionId;
  const syncFrom = cursor => cli("sync", "--session", session,
    ...(cursor === undefined ? [] : ["--cursor", cursor]));
  const syncScope = scope => cli("sync", "--session", session,
    ...(scope === undefined ? [] : ["--scope", scope]));
  return { project, env, cli, session, syncFrom, syncScope };
}

// Only rejected inputs share this fixture: they must not change its durable
// authorities. Valid syncs and hooks keep independent workspaces.
async function durableState(place) {
  const root = path.join(place.env.ACC_DATA_HOME, "acc", "workspaces");
  const files = [];
  for (const workspace of await readdir(root)) {
    for (const area of ["state", "events", "journal", path.join("retained", "state")]) {
      const directory = path.join(root, workspace, area);
      const entries = await readdir(directory, { recursive: true, withFileTypes: true })
        .catch(error => { if (error.code === "ENOENT") return []; throw error; });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const file = path.join(entry.parentPath, entry.name);
        files.push([path.relative(root, file), await readFile(file)]);
      }
    }
    // The event floor is durable despite living beside transient lock files.
    for (const name of ["protocol.json", path.join("locks", "retention.json")]) {
      const file = path.join(root, workspace, name);
      const bytes = await readFile(file)
        .catch(error => { if (error.code === "ENOENT") return null; throw error; });
      files.push([path.relative(root, file), bytes]);
    }
  }
  return files.sort(([left], [right]) => left.localeCompare(right));
}

let invalidFixture;
let invalidCleanup;
after(() => invalidCleanup?.());

async function invalidWorkspace(t) {
  // The file owns cleanup, so an individual consumer cannot remove the fixture
  // before the remaining cases run. workspace registers it even if setup fails.
  invalidFixture ??= workspace({ after: cleanup => { invalidCleanup = cleanup; } })
    .then(async place => ({
      place, before: await durableState(place),
    }));
  const { place, before } = await invalidFixture;
  t.after(async () => assert.deepEqual(await durableState(place), before,
    "a rejected sync changed durable state"));
  return place;
}

for (const cursor of ["not-a-cursor", "-1", "0000000000000001; DROP", "1", "00000000000000001"]) {
  test(`a cursor of ${JSON.stringify(cursor)} is refused, not answered with silence`, async t => {
    const place = await invalidWorkspace(t);

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

/**
 * The scope that answers "show me everything".
 *
 * An unknown one became `delta`. So `--scope ful` answered the one question the
 * full scope exists for - a session that cannot see the rest of the system - with
 * a delta carrying no snapshot at all, and the agent had no way to tell that from
 * a workspace with nothing in it.
 */
for (const scope of ["ful", "FULL", "nonsense", ""]) {
  test(`a scope of ${JSON.stringify(scope)} is refused, not turned into a delta`, async t => {
    const place = await invalidWorkspace(t);

    const refused = await place.syncScope(scope).then(() => null, error => error);

    assert.notEqual(refused, null, `${scope} was quietly answered with a delta`);
    assert.match(JSON.parse(refused.stdout ?? "{}").error?.message ?? refused.stderr,
      /scope is one of|requires a value/);
  });
}

test("the two scopes that exist still work, and one is the default", async t => {
  const place = await workspace(t);

  const full = JSON.parse((await place.syncScope("full")).stdout).data;
  const delta = JSON.parse((await place.syncScope("delta")).stdout).data;
  const plain = JSON.parse((await place.syncScope()).stdout).data;

  assert.equal("snapshot" in full, true, "the full scope carried no snapshot");
  assert.equal("snapshot" in delta, false);
  assert.equal(plain.scope, "delta");
});
