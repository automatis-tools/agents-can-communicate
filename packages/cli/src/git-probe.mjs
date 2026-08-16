import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends into the
 * environment of everything it runs, hooks included. Inheriting them makes a
 * probe describe whichever repository invoked us rather than the workspace at
 * `cwd` - which, during the reconciliation, is exactly how a test suite running
 * under a pre-push hook mutated the repository it was meant to be testing.
 * ACC adapters are hook-driven by design, so the default probe strips them.
 */
export function hermeticEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
}

export function createGitProbe({ run } = {}) {
  const exec = run ?? (async (cwd, args) =>
    (await execFileAsync("git", args, { cwd, env: hermeticEnv() })).stdout.trim());

  return async function gitProbe({ cwd }) {
    const commonDir = await exec(cwd, ["rev-parse", "--path-format=absolute",
      "--git-common-dir"]);
    if (typeof commonDir !== "string" || commonDir.length === 0) return null;
    const worktreeRoot = await exec(cwd, ["rev-parse", "--show-toplevel"]);
    // A detached head or an unborn branch is normal, not an error: enrichment
    // reports what exists and leaves the rest null.
    const branch = await exec(cwd, ["branch", "--show-current"]).catch(() => "");
    const head = await exec(cwd, ["rev-parse", "HEAD"]).catch(() => "");
    const remote = await exec(cwd, ["remote", "get-url", "origin"]).catch(() => "");
    return {
      commonDir: path.resolve(cwd, commonDir),
      worktreeRoot: path.resolve(cwd, worktreeRoot),
      branch: branch.length > 0 ? branch : null,
      head: head.length > 0 ? head : null,
      remote: remote.length > 0 ? remote : null,
    };
  };
}
