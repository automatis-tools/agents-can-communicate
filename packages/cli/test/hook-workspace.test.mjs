import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHookWorkspace, resolveSavedHookWorkspace } from "../src/hook-workspace.mjs";

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

test("saved room selectors reject path escape, missing records, symlinks and a changed identity", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-room-selector-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const options = { cwd, dataHome: path.join(root, "data"), env: {}, gitProbe: async () => null,
    clock: { now: () => new Date().toISOString() }, deadlineAt: Date.now() + 10_000 };
  const room = await resolveHookWorkspace({ ...options, adapterId: "fixture",
    event: { kind: "sessionStart", sessionId: "native", cwd } });
  const resolved = await resolveSavedHookWorkspace({ ...options, reference: room.workspaceRef });
  assert.equal(resolved.descriptor.id, room.descriptor.id);
  for (const reference of ["acc://../../outside", "acc://", "acc://" + "a".repeat(64)]) {
    await assert.rejects(resolveSavedHookWorkspace({ ...options, reference }));
  }
  assert.equal(await resolveSavedHookWorkspace({ ...options,
    reference: path.join(root, "config.json") }), null, "ordinary configs must retain their own parser");
  const file = path.join(options.dataHome, "acc", "native-workspaces", room.workspaceRef.slice(6) + ".json");
  const bytes = await readFile(file);
  const outside = path.join(root, "copied.json");
  await writeFile(outside, bytes);
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(resolveSavedHookWorkspace({ ...options, reference: room.workspaceRef }));
  await rm(file);
  await writeFile(file, JSON.stringify({ ...JSON.parse(bytes), nativeSessionId: "replacement" }));
  await assert.rejects(resolveSavedHookWorkspace({ ...options, reference: room.workspaceRef }),
    /invalid native workspace binding/);
});
