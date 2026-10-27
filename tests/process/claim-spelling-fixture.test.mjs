import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { claimSpellingProject } from "../helpers/claim-spelling-project.mjs";
import { fixtureOwnerEnv } from "../helpers/fixture-owner.mjs";

const run = promisify(execFile);
const hookEnv = participant => ({ ACC_TEST_EXPIRE_PARTICIPANT: participant,
  NODE_OPTIONS: `--import=${pathToFileURL(path.resolve(import.meta.dirname,
    "../helpers/expire-hook-clock.mjs")).href}` });

for (const participant of ["holder", "writer"]) {
  test(`claim guard fixture refuses fail-open ${participant} SessionStart as ready`, async t => {
    await assert.rejects(claimSpellingProject(t, { hookEnv: hookEnv(participant) }),
      error => {
        assert.match(error.message,
          new RegExp(`claim fixture: ${participant} SessionStart did not establish usable context`));
        assert.match(error.message, /exit 0; stderr: acc: coordination unavailable/);
        return true;
      });
  });
}

test("claim rejection fixture uses a real CLI owner without hook startup", async t => {
  const place = await claimSpellingProject(t, { owner: "cli", hookEnv: hookEnv("holder") });
  // A positive command proves the CLI-returned pair owns a real session.
  assert.match((await place.claim("file:src/physics.mjs")).stdout, /claimed file:src\/physics.mjs/);
  await assert.rejects(fixtureOwnerEnv(place.env.ACC_DATA_HOME, "holder"),
    /fixture must own exactly one binding/);
  const failure = await place.claim("file:src/*.mjs").then(() => null, error => error);
  assert.equal(failure?.code, 2, failure?.message);
  assert.match(failure.stderr, /matches nothing: only a trailing \/\*\* is understood/);
});

test("claim guard fixture accepts the real Codex deny contract and an unrelated write", async t => {
  const place = await claimSpellingProject(t);
  await place.claim("file:src/physics.mjs");
  const holder = await fixtureOwnerEnv(place.env.ACC_DATA_HOME, "holder");
  const child = run(process.execPath,
    [path.resolve(import.meta.dirname, "../../bin/acc-hook.mjs"), "codex"],
    { env: { ...place.env, ACC_PARTICIPANT: "writer" }, cwd: place.root });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "writer",
    cwd: place.root, tool_name: "apply_patch", tool_input: {
      command: "*** Begin Patch\n*** Update File: src/physics.mjs\n@@\n-a\n+b\n*** End Patch",
    } }));
  const failure = await child.then(() => null, error => error);
  assert.equal(failure?.code, 2, failure?.message);
  assert.equal(failure.stdout, "");
  assert.equal(failure.stderr.trim(),
    `file:src/physics.mjs is claimed by holder (session ${holder.ACC_SESSION})`);
  assert.equal(await place.write("src/physics.mjs"), "deny");
  assert.equal(await place.write("README.md"), "allow");
});

// Each control catches the old mapping of any executor rejection to "deny".
// Only EACCES is injected; the other two faults cross the real process boundary.
for (const [name, execute, check] of [
  ["missing module", (_input, options) => run(process.execPath, ["--input-type=module", "-e",
    `console.log('module control started'); await import(${JSON.stringify(
      pathToFileURL(path.join(import.meta.dirname, "missing-claim-hook.mjs")).href)});`], options),
  error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "module control started\n");
    assert.match(error.stderr, /ERR_MODULE_NOT_FOUND/);
  }],
  ["process timeout", (_input, options) => run(process.execPath, ["-e",
    "console.log('timeout control started'); console.error('still running'); setInterval(() => {}, 1000)"],
  { ...options, timeout: 1000 }), error => {
    assert.equal(error.killed, true);
    assert.equal(error.stdout, "timeout control started\n");
    assert.equal(error.stderr, "still running\n");
  }],
  ["injected spawn EACCES", async () => {
    throw Object.assign(new Error("spawn claim-hook EACCES"), {
      code: "EACCES", syscall: "spawn claim-hook", path: "claim-hook", stdout: "", stderr: "",
    });
  }, error => {
    assert.equal(error.code, "EACCES");
    assert.equal(error.syscall, "spawn claim-hook");
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "");
  }],
  ["exit 2 without an owner/resource denial", (_input, options) => run(process.execPath,
    ["-e", "console.error('acc: failed to load hook'); process.exitCode = 2"], options),
  error => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "acc: failed to load hook\n");
  }],
]) {
  test(`claim guard fixture rejects ${name} and preserves its original error`, async t => {
    let original;
    const place = await claimSpellingProject(t, { runWrite: async (...args) => {
      try { return await execute(...args); }
      catch (error) { original = error; throw error; }
    } });
    await place.claim("file:src/physics.mjs");
    await assert.rejects(place.write("src/physics.mjs"), error => {
      assert.equal(error, original);
      check(error);
      return true;
    });
  });
}

test("claim guard fixture rejects a zero-exit fail-open diagnostic", async t => {
  const place = await claimSpellingProject(t, { runWrite: (_input, options) =>
    run(process.execPath, ["-e", "console.error('acc: coordination unavailable: control')"], options) });
  await place.claim("file:src/physics.mjs");
  await assert.rejects(place.write("src/physics.mjs"), error => {
    assert.match(error.message, /claim fixture: writer PreToolUse.*exit 0/);
    assert.equal(error.code, 0);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "acc: coordination unavailable: control\n");
    return true;
  });
});
