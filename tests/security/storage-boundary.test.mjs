import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverWorkspace, platformPaths, runtimePaths }
  from "@agents-can-communicate/cli";
import { EXIT, validateProjectConfig } from "@agents-can-communicate/protocol";

/**
 * The managed root is the boundary.
 *
 * ACC reads and writes on behalf of a model that another person is prompting.
 * Anything that lets a path leave the runtime root - a symlink, a `..`, a
 * config field, an environment variable - turns coordination state into a
 * write primitive aimed at the rest of the machine.
 */
async function place(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-sec-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("runtime state cannot be placed inside a workspace", async t => {
  const root = await place(t);

  // The regression the design exists to prevent, and the one a user can reach
  // honestly by pointing XDG_DATA_HOME into a checkout.
  assert.throws(() => runtimePaths({ dataHome: root, workspaceId: "workspace_a",
    workspaceRoots: [root] }), error => error.code === EXIT.USAGE);
  assert.throws(() => platformPaths({ platform: "linux",
    env: { HOME: "/home/dana", XDG_DATA_HOME: `${root}/.acc` },
    workspaceRoots: [root] }), error => error.code === EXIT.USAGE);
});

test("a workspace id cannot walk out of the runtime root", async t => {
  const root = await place(t);

  // The id reaches this from a config file in a repository, so it is foreign
  // input. Unchecked it is a directory traversal with a friendly name.
  for (const id of ["../escape", "..", "a/../../b", "/absolute"]) {
    assert.throws(() => runtimePaths({ dataHome: root, workspaceId: id }),
      error => error.code === EXIT.DATA || error.code === EXIT.USAGE,
      `${id} was accepted as a workspace id`);
  }
});

test("a config cannot point a workspace root outside itself", () => {
  const valid = { schemaVersion: 1, workspaceId: "workspace_a" };

  for (const root of ["/etc", "../sibling", "packages/../../escape"]) {
    assert.throws(() => validateProjectConfig({ ...valid, roots: [root] }),
      error => error.code === EXIT.DATA, `${root} was accepted`);
  }
});

test("a config reached through a symlink is refused, not followed", async t => {
  const root = await place(t);
  const elsewhere = path.join(root, "elsewhere.json");
  await writeFile(elsewhere,
    `${JSON.stringify({ schemaVersion: 1, workspaceId: "workspace_linked" })}\n`);
  const project = path.join(root, "project");
  await mkdir(project);
  await symlink(elsewhere, path.join(project, "acc.workspace.json"));

  // A link may point at a file the repository does not control, including one
  // outside it entirely.
  await assert.rejects(discoverWorkspace({ cwd: project, env: {}, gitProbe: () => null }),
    error => error.code === EXIT.DATA);
});

test("a config cannot smuggle runtime state into a repository", () => {
  // This file is committed, so anyone who can open a pull request can edit it.
  // One that could declare sessions or tokens would hand a peer state it should
  // have had to earn.
  for (const key of ["sessions", "claims", "messages", "tokens", "credentials"]) {
    assert.throws(() => validateProjectConfig({ schemaVersion: 1,
      workspaceId: "workspace_a", [key]: [] }),
      error => error.code === EXIT.DATA && new RegExp(key).test(error.message));
  }
});

test("an environment override still cannot escape into a workspace", async t => {
  const root = await place(t);

  // ACC_DATA_HOME is the supported way to relocate state, and it is not a way
  // around the boundary.
  assert.throws(() => platformPaths({ platform: "darwin",
    env: { HOME: "/Users/dana", ACC_DATA_HOME: path.join(root, "inside") },
    workspaceRoots: [root] }), error => error.code === EXIT.USAGE);
});

test("a relative data home is refused rather than resolved against the cwd", () => {
  // Resolved against the working directory it would land in whatever project
  // the session happens to be running in.
  assert.throws(() => runtimePaths({ dataHome: "relative/data",
    workspaceId: "workspace_a" }), error => error.code === EXIT.USAGE);
  assert.throws(() => platformPaths({ platform: "linux",
    env: { HOME: "/home/dana", ACC_DATA_HOME: "relative/data" } }),
    error => error.code === EXIT.USAGE);
});
