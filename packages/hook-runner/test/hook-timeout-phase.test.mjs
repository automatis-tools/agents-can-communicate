import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { completeHookOutput } from "../../../bin/entrypoints/hook-output.mjs";
import { runHook } from "../src/runner.mjs";

// A hook that runs out of its budget fails open, and "coordination unavailable"
// alone said nothing about where the time went: on main's Windows job three
// hooks passed five seconds with no slow filesystem call or child process behind
// them. The step a hook was in when its budget ran out is now part of the answer.
test("a hook that runs out of budget says which step held it", async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-phase-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = path.join(home, "project");
  await mkdir(project);
  const adapter = createClaudeCodeAdapter();
  const result = await runHook({ adapterId: adapter.id, adapters: { [adapter.id]: adapter },
    payload: { hook_event_name: "SessionStart", session_id: "phase", cwd: project },
    dataHome: path.join(home, "data"), env: { HOME: home, PATH: "" }, budgetMs: 1_500,
    readProcessTable: () => new Promise(() => {}), probeClientVersion: async () => "2.1.286" });
  assert.equal(result.timedOut, true);
  assert.equal(result.phase, "reading the process table");
});

function streams() {
  const written = { stdout: "", stderr: "" };
  const stream = name => ({ write: (chunk, done) => { written[name] += chunk; done?.(); return true; } });
  return { written, stdout: stream("stdout"), stderr: stream("stderr") };
}

test("the fail-open line names the step, and only a step ACC itself names", async () => {
  const named = streams();
  await completeHookOutput({ stdout: "", timedOut: true, phase: "reading the process table" }, named);
  assert.match(named.written.stderr, /timed out while reading the process table/);
  const other = streams();
  await completeHookOutput({ stdout: "", timedOut: true, phase: "rm -rf $HOME" }, other);
  assert.equal(other.written.stderr.includes("rm -rf"), false);
  assert.match(other.written.stderr, /coordination unavailable; hook continued without context/);
});
