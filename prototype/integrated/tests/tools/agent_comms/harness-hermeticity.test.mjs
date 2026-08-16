// Regression for a real incident: run under a git hook, the suite inherited
// GIT_DIR and every fixture operated on the ambient repository instead of its
// own temporary one. That flipped the real repo to bare, created a stray
// branch, and stacked empty "fixture" commits onto the working branch.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGitWorktreeFixture, hermeticEnv, runCli } from "./helpers.mjs";

function withEnvironment(t, values) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("hermeticEnv strips every inherited git variable", () => {
  const environment = hermeticEnv({ PW2_AGENT_BUS_DIR: "/tmp/bus" });

  assert.deepEqual(Object.keys(environment).filter(key => key.startsWith("GIT_")), []);
  assert.equal(environment.PW2_AGENT_BUS_DIR, "/tmp/bus");
  assert.equal(environment.PATH, process.env.PATH, "the rest of the environment was dropped");
});

test("fixtures ignore an ambient GIT_DIR belonging to another repository", async t => {
  // A git hook exports these. Pointing them somewhere that does not exist means
  // any leaked variable makes fixture git commands fail loudly instead of
  // silently mutating whatever repository the suite happens to run inside.
  withEnvironment(t, {
    GIT_DIR: path.join(os.tmpdir(), "acc-absent-git-dir"),
    GIT_WORK_TREE: path.join(os.tmpdir(), "acc-absent-work-tree"),
    GIT_INDEX_FILE: path.join(os.tmpdir(), "acc-absent-index"),
  });

  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);

  const initialized = await runCli(fixture, ["init"], { cwd: fixture.worktree });
  assert.equal(initialized.code, 0, initialized.stderr);
  const registered = await runCli(fixture, ["register", "--id", "visual", "--role", "artist",
    "--task", "M2.7", "--json"], { cwd: fixture.worktree });
  assert.equal(registered.code, 0, registered.stderr);

  // The registration records Git state, so a leaked GIT_DIR would surface here
  // as another repository's branch and HEAD rather than the fixture's own.
  assert.equal(JSON.parse(registered.stdout).branch, "linked");
});
