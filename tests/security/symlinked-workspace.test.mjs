import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * A guard that only holds when the path is spelled one particular way is not a
 * guard.
 *
 * Workspace discovery resolves its root through `realpath`, so the descriptor
 * always carries a canonical path. A hook payload carries whatever the client
 * had - and a client's cwd is whatever the human typed. When those disagree
 * only by a symlinked ancestor, the relative path came out as `../..`, the
 * target list emptied, and every write was allowed. Silently: exit 0, no
 * message, and `acc status` still reporting `protection guarded`.
 *
 * This is not exotic. On macOS `/tmp` and `/var` are symlinks, and a checkout
 * reached through any symlinked parent behaves the same way on every platform.
 */
async function workspace(t, { throughSymlink }) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-symlink-")));
  t.after(() => rm(base, { recursive: true, force: true }));

  const real = path.join(base, "real");
  await mkdir(path.join(real, "src", "store"), { recursive: true });
  const link = path.join(base, "link");
  await symlink(real, link);

  // The only difference between the two runs. Both name the same directory.
  const project = throughSymlink ? link : real;
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };

  const start = (adapter, clientSessionId) => {
    const child = run(process.execPath, [hook, adapter, "sessionStart"], { env });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: clientSessionId, cwd: project, source: "startup" }));
    return child;
  };
  await start("codex", "owner-1");
  await start("claude_code", "writer-1");

  const { stdout: reported } = await run(process.execPath,
    [acc, "doctor", "--cwd", project, "--json"], { env });
  const runtimeDir = JSON.parse(reported).data.runtimeRoot;
  const owner = await loadSessionBinding({ runtimeDir, harnessSessionId: "owner-1" });

  await run(process.execPath, [acc, "claim", "--session", owner.accSessionId,
    "--generation", owner.generation, "--cwd", project,
    "--resource", "file:src/store/**", "--enforcement", "guarded",
    "--reason", "porting"], { env });

  return { project, env };
}

/** What the writer's client is told when it tries to write into the claim. */
async function attemptWrite({ project, env }) {
  const child = run(process.execPath, [hook, "claude_code", "preToolUse"], { env });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse",
    session_id: "writer-1", cwd: project, tool_name: "Write",
    tool_input: { file_path: path.join(project, "src", "store", "index.mjs") } }));
  const { stdout } = await child;
  return stdout;
}

test("a claim is enforced when the workspace is reached through a symlink", async t => {
  const place = await workspace(t, { throughSymlink: true });

  const stdout = await attemptWrite(place);

  assert.match(stdout, /"permissionDecision"\s*:\s*"deny"/,
    "the write was allowed through a symlinked path while status reported guarded");
  assert.match(stdout, /file:src\/store\/\*\*/);
});

test("the same claim is enforced when the workspace is reached directly", async t => {
  // The control. Without it a broken guard could pass the test above by
  // denying everything, and a broken *test* could pass by asserting nothing.
  const place = await workspace(t, { throughSymlink: false });

  const stdout = await attemptWrite(place);

  assert.match(stdout, /"permissionDecision"\s*:\s*"deny"/);
});

test("a write outside the claim is still allowed through a symlink", async t => {
  // The guard must not become "deny everything" as a way of passing the first
  // test. A path the claim does not cover has to go through untouched.
  const place = await workspace(t, { throughSymlink: true });

  const child = run(process.execPath, [hook, "claude_code", "preToolUse"], { env: place.env });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse",
    session_id: "writer-1", cwd: place.project, tool_name: "Write",
    tool_input: { file_path: path.join(place.project, "src", "cli", "args.mjs") } }));
  const { stdout } = await child;

  assert.equal(stdout, "", `an unrelated write was interfered with: ${stdout}`);
});
