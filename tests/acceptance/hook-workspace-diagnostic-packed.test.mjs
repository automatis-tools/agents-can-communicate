import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);

// Regression: launching Gemini from HOME hid the useful workspace refusal
// behind a generic warning. Exercise the installed executable, not its formatter.
test("installed hooks explain an unusable workspace without blocking the client", async t => {
  const packed = await createPackedAcc(t);
  const dataHome = path.join(packed.clientHome, "app-data");
  const env = { ACC_DATA_HOME: dataHome };
  const payload = { hook_event_name: "SessionStart", session_id: "home-session",
    cwd: packed.clientHome };

  await t.test("home refusal names the remedy and creates no workspace state", async () => {
    for (const hook_event_name of ["SessionStart", "BeforeAgent", "BeforeTool", "SessionEnd"]) {
      const result = await packed.hook("gemini_cli", { ...payload, hook_event_name }, env);
      assert.equal(result.stdout, "", "a failed hook injected context");
      assert.match(result.stderr, /workspace contains ACC runtime state/);
      assert.match(result.stderr, /open a project directory and restart the client/);
      assert.match(result.stderr, /ACC_DATA_HOME outside the workspace/);
      assert.match(result.stderr, /hook continued without context/);
      assert.equal(result.stderr.includes(packed.clientHome), false, "hook reflected a path");
    }
    const entries = await readdir(path.join(dataHome, "acc", "workspaces"))
      .catch(error => { if (error.code === "ENOENT") return []; throw error; });
    assert.deepEqual(entries, [], "rejected workspace acquired runtime state");
  });

  await t.test("unclassified filesystem errors do not leak their details", async () => {
    const cwd = path.join(packed.clientHome, "PRIVATE-PATH-CANARY");
    const result = await packed.hook("gemini_cli", { ...payload, cwd }, env);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "acc: coordination unavailable; hook continued without context\n");
  });

  await t.test("a project under the same home still registers, injects identity and closes", async () => {
    const cwd = path.join(packed.clientHome, "project");
    await mkdir(cwd);
    const invoke = hook_event_name => packed.hook("gemini_cli",
      { ...payload, cwd, hook_event_name }, env);
    assert.equal((await invoke("SessionStart")).stderr, "");
    const turn = await invoke("BeforeAgent");
    assert.doesNotMatch(turn.stderr, /coordination unavailable/);
    const context = JSON.parse(turn.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /ACC CLI \(append\): --session session_[\w-]+ --generation generation_[\w-]+/);
    assert.equal((await invoke("SessionEnd")).stderr, "");
    const { stdout } = await run(process.execPath,
      [packed.accBin, "status", "--cwd", cwd, "--json"],
      { cwd, env: { ...packed.env, ...env } });
    const status = JSON.parse(stdout).data;
    assert.equal(status.participants.filter(p => p.presence !== "offline").length, 0);
  });
});
