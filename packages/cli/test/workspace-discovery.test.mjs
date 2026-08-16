import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { discoverWorkspace } from "../src/workspace-discovery.mjs";

async function tempRoot(t, prefix = "acc-discovery-") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const noGit = async () => null;

// A probe that reports one repository with two worktrees sharing a common dir.
function gitProbeFor(commonDir, worktrees) {
  return async ({ cwd }) => {
    const worktreeRoot = worktrees.find(root => cwd === root || cwd.startsWith(`${root}${path.sep}`));
    if (worktreeRoot === undefined) return null;
    return { commonDir, worktreeRoot, branch: "main", head: "a".repeat(40), remote: null };
  };
}

test("a plain directory is a workspace without Git", async t => {
  const root = await tempRoot(t);

  const descriptor = await discoverWorkspace({ cwd: root, env: {}, gitProbe: noGit });

  assert.equal(descriptor.source, "directory");
  assert.deepEqual(descriptor.roots, [root]);
  assert.equal(descriptor.displayName, path.basename(root));
  assert.equal("git" in descriptor, false);
  assert.match(descriptor.id, /^workspace_[a-f0-9]{32}$/);
});

test("the directory identity is stable and canonical", async t => {
  const root = await tempRoot(t);
  const nested = path.join(root, "src", "deep");
  await mkdir(nested, { recursive: true });

  const fromRoot = await discoverWorkspace({ cwd: root, env: {}, gitProbe: noGit });
  const fromNested = await discoverWorkspace({ cwd: nested, env: {}, gitProbe: noGit });
  const again = await discoverWorkspace({ cwd: root, env: {}, gitProbe: noGit });

  assert.equal(fromRoot.id, again.id);
  // Without Git or config there is nothing that marks the repository root, so a
  // nested directory is its own workspace. Identity must still be canonical.
  assert.notEqual(fromNested.id, fromRoot.id);
  assert.deepEqual(fromNested.roots, [nested]);
});

test("two Git worktrees share one workspace identity", async t => {
  const root = await tempRoot(t);
  const main = path.join(root, "main");
  const linked = path.join(root, "linked");
  const commonDir = path.join(main, ".git");
  await mkdir(main);
  await mkdir(linked);
  await mkdir(commonDir);
  const gitProbe = gitProbeFor(commonDir, [main, linked]);

  const first = await discoverWorkspace({ cwd: main, env: {}, gitProbe });
  const second = await discoverWorkspace({ cwd: linked, env: {}, gitProbe });

  assert.equal(first.source, "git");
  assert.equal(first.id, second.id, "worktrees of one repository disagreed on identity");
  assert.notEqual(first.git.worktreeRoot, second.git.worktreeRoot);
  assert.equal(first.git.branch, "main");
});

test("a failing Git probe degrades to a directory workspace", async t => {
  const root = await tempRoot(t);

  const descriptor = await discoverWorkspace({ cwd: root, env: {},
    gitProbe: async () => { throw new Error("git: command not found"); } });

  assert.equal(descriptor.source, "directory");
  assert.equal("git" in descriptor, false);
});

test("an explicit config supplies a stable identity that survives a move", async t => {
  const root = await tempRoot(t);
  const before = path.join(root, "before");
  const after = path.join(root, "after");
  await mkdir(before);
  const configPath = path.join(before, "acc.workspace.json");
  await writeFile(configPath, `${JSON.stringify({ schemaVersion: 1,
    workspaceId: "workspace_pinned", displayName: "Pinned", roots: ["."] })}\n`);

  const original = await discoverWorkspace({ cwd: before, env: {}, gitProbe: noGit,
    explicitConfig: configPath });
  await rename(before, after);
  const moved = await discoverWorkspace({ cwd: after, env: {}, gitProbe: noGit,
    explicitConfig: path.join(after, "acc.workspace.json") });

  assert.equal(original.source, "config");
  assert.equal(original.id, "workspace_pinned");
  assert.equal(moved.id, original.id, "a configured workspace lost its identity when moved");
  assert.deepEqual(moved.roots, [after]);
});

test("config identity outranks Git identity", async t => {
  const root = await tempRoot(t);
  const commonDir = path.join(root, ".git");
  await mkdir(commonDir);
  const configPath = path.join(root, "acc.workspace.json");
  await writeFile(configPath, `${JSON.stringify({ schemaVersion: 1,
    workspaceId: "workspace_pinned", displayName: "Pinned", roots: ["."] })}\n`);

  const descriptor = await discoverWorkspace({ cwd: root, env: {},
    gitProbe: gitProbeFor(commonDir, [root]), explicitConfig: configPath });

  assert.equal(descriptor.source, "config");
  assert.equal(descriptor.id, "workspace_pinned");
  // Git metadata still enriches the descriptor; it just does not decide identity.
  assert.equal(descriptor.git.worktreeRoot, root);
});

test("a relative override is rejected instead of resolved against the cwd", async t => {
  const root = await tempRoot(t);

  await assert.rejects(discoverWorkspace({ cwd: root, env: { ACC_WORKSPACE_ROOT: "../elsewhere" },
    gitProbe: noGit }), error => error.code === EXIT.USAGE);
});

test("an absolute override selects the workspace root", async t => {
  const root = await tempRoot(t);
  const other = await tempRoot(t, "acc-other-");

  const descriptor = await discoverWorkspace({ cwd: root,
    env: { ACC_WORKSPACE_ROOT: other }, gitProbe: noGit });

  assert.deepEqual(descriptor.roots, [other]);
});

test("a symlinked config is refused rather than followed", async t => {
  const root = await tempRoot(t);
  const outside = path.join(root, "outside.json");
  const configPath = path.join(root, "acc.workspace.json");
  await writeFile(outside, `${JSON.stringify({ schemaVersion: 1,
    workspaceId: "workspace_smuggled", displayName: "Smuggled", roots: ["."] })}\n`);
  await symlink(outside, configPath);

  await assert.rejects(discoverWorkspace({ cwd: root, env: {}, gitProbe: noGit,
    explicitConfig: configPath }), error => error.code === EXIT.DATA);
});

test("a config with an unknown schema version fails closed", async t => {
  const root = await tempRoot(t);
  const configPath = path.join(root, "acc.workspace.json");
  await writeFile(configPath, `${JSON.stringify({ schemaVersion: 99,
    workspaceId: "workspace_pinned", displayName: "Pinned", roots: ["."] })}\n`);

  await assert.rejects(discoverWorkspace({ cwd: root, env: {}, gitProbe: noGit,
    explicitConfig: configPath }), error => error.code === EXIT.DATA);
});

test("a config carrying runtime state is refused", async t => {
  const root = await tempRoot(t);
  const configPath = path.join(root, "acc.workspace.json");
  await writeFile(configPath, `${JSON.stringify({ schemaVersion: 1,
    workspaceId: "workspace_pinned", displayName: "Pinned", roots: ["."],
    sessions: [{ sessionId: "session_a" }] })}\n`);

  // Project config carries policy and identity only. Presence, messages, and
  // locks belong to the runtime directory and must never enter a repository.
  await assert.rejects(discoverWorkspace({ cwd: root, env: {}, gitProbe: noGit,
    explicitConfig: configPath }), error => error.code === EXIT.DATA
    && error.message.includes("sessions"));
});

test("discovery performs no CLI side effects", async t => {
  const root = await tempRoot(t);
  const source = await import("node:fs/promises")
    .then(fs => fs.readFile(new URL("../src/workspace-discovery.mjs", import.meta.url), "utf8"));

  // packages/mcp-server and the native adapters import this module directly, so
  // it must not parse arguments, write to stdout, or exit the process.
  assert.equal(/process\.(exit|stdout|stderr|argv)/.test(source), false);
  assert.equal(typeof (await discoverWorkspace({ cwd: root, env: {}, gitProbe: noGit })).id,
    "string");
});
