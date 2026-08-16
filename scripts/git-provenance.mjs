// Which revision a build artefact belongs to.
//
// A digest on its own goes stale on the next merge - every workspace travels
// inside the tarball, so any change to shipped code changes it - and a stale
// digest recorded without its commit reads as a claim about the current tree
// rather than a true one about an older commit. A dirty tree is worse: nobody
// can rebuild that tarball, so the evidence proves nothing.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// The suite and the release workflow both export GIT_DIR='' so that git
// commands inside temporary fixture repositories cannot operate on this
// checkout. An empty GIT_DIR is not "unset" to git - it is a repository path of
// "", and every command fails with `not a git repository: ''`. Stripped rather
// than caught: swallowing the failure would drop the revision precisely when
// the script is run the way the release doc says to run it.
const INHERITED = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
  "GIT_QUARANTINE_PATH"];

/**
 * @param {string} cwd directory to describe
 * @returns {Promise<{commit: string|null, dirty: boolean, why?: string}>}
 *   `commit` is null outside a checkout, with `why` saying so. Not an error:
 *   an artefact built elsewhere is still verifiable, just not attributable.
 */
export async function gitProvenance(cwd) {
  const env = { ...process.env };
  for (const name of INHERITED) delete env[name];

  try {
    const { stdout: head } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd, env });
    const { stdout: dirt } = await run("git", ["status", "--porcelain"], { cwd, env });
    return { commit: head.trim(), dirty: dirt.trim() !== "" };
  } catch (error) {
    return { commit: null, dirty: false,
      why: String(error.message).trim().split("\n").at(-1) };
  }
}
