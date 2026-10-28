// Synthetic CI events over a private real Git merge graph; never native CI proof.
import { fixture, git, put, commit } from "./change-plan-fixture.mjs";

export async function ciFixture(t, { format = "sha1", scope = "docs" } = {}) {
  const f = await fixture(t, format);
  if (scope === "full") {
    await put(f.repo, "tests/runtime.test.mjs", "export const changed = true;\n");
    f.target = await commit(f.repo);
  }
  const head = f.target;
  const tree = await git(f.repo, "rev-parse", `${head}^{tree}`);
  const target = await git(f.repo, "commit-tree", tree, "-p", f.base, "-p", head, "-m", "private validation merge");
  await git(f.repo, "checkout", "--detach", "-q", target);
  const event = { number: 17, pull_request: { number: 17, base: { sha: f.base }, head: { sha: head } } };
  const env = { CI: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/17/merge",
    GITHUB_SHA: target, GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "1" };
  return { repo: f.repo, base: f.base, head, target, env, event };
}
