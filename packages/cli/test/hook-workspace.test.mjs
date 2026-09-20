import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHookWorkspace } from "../src/hook-workspace.mjs";

test("a bound Git room remains available when Git later cannot be probed", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-room-git-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const sub = path.join(repo, "src");
  const commonDir = path.join(repo, ".git");
  for (const directory of [sub, commonDir]) await mkdir(directory, { recursive: true });
  const options = { adapterId: "fixture", dataHome: path.join(root, "data"), env: {},
    clock: { now: () => new Date().toISOString() }, deadlineAt: Date.now() + 10_000 };
  const initial = await resolveHookWorkspace({ ...options,
    event: { kind: "sessionStart", sessionId: "native", cwd: sub },
    gitProbe: async () => ({ commonDir, worktreeRoot: repo }) });
  for (const kind of ["beforeTurn", "beforeTool", "sessionEnd"]) {
    const next = await resolveHookWorkspace({ ...options,
      event: { kind, sessionId: "native", cwd: repo }, gitProbe: async () => null });
    assert.equal(next.descriptor.id, initial.descriptor.id);
    assert.equal(next.descriptor.source, "git");
    assert.equal(next.descriptor.git.worktreeRoot, repo,
      "Git failure must not rebase repository-relative claims onto the launch subdirectory");
    assert.equal(next.workspaceCwd, sub);
  }
});

test("Git becoming available does not move a room initially opened without Git", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-room-git-return-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const sub = path.join(repo, "src");
  const commonDir = path.join(repo, ".git");
  for (const directory of [sub, commonDir]) await mkdir(directory, { recursive: true });
  const options = { adapterId: "fixture", dataHome: path.join(root, "data"), env: {},
    clock: { now: () => new Date().toISOString() }, deadlineAt: Date.now() + 10_000 };
  const initial = await resolveHookWorkspace({ ...options,
    event: { kind: "sessionStart", sessionId: "native", cwd: sub }, gitProbe: async () => null });
  const next = await resolveHookWorkspace({ ...options,
    event: { kind: "beforeTurn", sessionId: "native", cwd: repo },
    gitProbe: async () => ({ commonDir, worktreeRoot: repo }) });
  assert.equal(next.descriptor.id, initial.descriptor.id);
  assert.equal(next.descriptor.source, "directory");
  assert.deepEqual(next.descriptor.roots, [sub]);
  assert.equal(next.descriptor.git, undefined, "existing directory-relative claims must not be rebased");
});
