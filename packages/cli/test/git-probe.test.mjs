import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createGitProbe, hermeticEnv } from "../src/git-probe.mjs";
import { discoverWorkspace } from "../src/workspace-discovery.mjs";

const execFileAsync = promisify(execFile);

async function gitRepository(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-git-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = path.join(root, "main");
  await mkdir(main);
  const run = args => execFileAsync("git", args, { cwd: main, env: hermeticEnv() });
  await run(["init", "--quiet", "--initial-branch=main"]);
  await run(["config", "user.email", "discovery@example.invalid"]);
  await run(["config", "user.name", "Discovery Test"]);
  await run(["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  return { root, main, run };
}

test("hermeticEnv drops every inherited git variable", () => {
  const environment = hermeticEnv({ GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere",
    PATH: "/usr/bin", HOME: "/home/example" });

  assert.deepEqual(Object.keys(environment).sort(), ["HOME", "PATH"]);
});

test("the probe describes the workspace at cwd, not an ambient GIT_DIR", async t => {
  const { root, main } = await gitRepository(t);
  const decoy = path.join(root, "decoy.git");
  await mkdir(decoy);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = decoy;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  });

  const probed = await createGitProbe()({ cwd: main });

  assert.equal(probed.worktreeRoot, main);
  assert.equal(probed.commonDir, path.join(main, ".git"));
  assert.equal(probed.branch, "main");
});

test("two real worktrees discover one workspace identity", async t => {
  const { root, main, run } = await gitRepository(t);
  const linked = path.join(root, "linked");
  await run(["worktree", "add", "--quiet", "-b", "topic", linked]);
  const gitProbe = createGitProbe();

  const first = await discoverWorkspace({ cwd: main, env: {}, gitProbe });
  const second = await discoverWorkspace({ cwd: linked, env: {}, gitProbe });

  assert.equal(first.source, "git");
  assert.equal(first.id, second.id);
  assert.notEqual(first.git.worktreeRoot, second.git.worktreeRoot);
  assert.equal(second.git.branch, "topic");
});

test("a directory that is not a repository yields no Git enrichment", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-plain-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const descriptor = await discoverWorkspace({ cwd: root, env: {},
    gitProbe: createGitProbe() });

  assert.equal(descriptor.source, "directory");
  assert.equal("git" in descriptor, false);
});
