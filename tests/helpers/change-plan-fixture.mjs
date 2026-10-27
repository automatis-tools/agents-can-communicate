// Real temporary Git repositories shared by planner integration controls.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
export const run = promisify(execFile);
export const source = path.resolve(import.meta.dirname, "../..");
import * as planner from "../../scripts/change-plan.mjs";
import * as gitModule from "../../scripts/change-plan-git.mjs";
export const event = { kind: "push", ref: "refs/heads/topic" };
export const git = async (repo, ...args) => (await run("git", ["-C", repo, ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
})).stdout.trim();
export async function put(repo, file, text = "export {};\n") {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), text);
}
export async function commit(repo) {
  await git(repo, "add", "-A");
  await git(repo, "-c", "core.hooksPath=", "commit", "-qm", "fixture");
  return git(repo, "rev-parse", "HEAD");
}
export async function audit(repo) {
  const manifest = JSON.parse(await readFile(path.join(source, "scripts/validation-impact.json"), "utf8"));
  await git(repo, "add", "-A");
  const tree = await git(repo, "write-tree");
  const entries = await gitModule.readTree(repo, tree);
  manifest.sourceDigest = planner.sourceDigest(entries);
  await put(repo, "scripts/validation-impact.json", JSON.stringify(manifest));
}
export async function fixture(t, format = "sha1") {
  const repo = await mkdtemp(path.join(tmpdir(), "acc-plan-git-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, "init", "-q", `--object-format=${format}`);
  await git(repo, "config", "user.email", "fixture@example.test");
  await git(repo, "config", "user.name", "Fixture");
  await put(repo, "README.md", "original\n");
  await put(repo, "tests/docs/links.test.mjs");
  await put(repo, "tests/runtime.test.mjs");
  const manifest = JSON.parse(await readFile(path.join(source, "scripts/validation-impact.json"), "utf8"));
  for (const file of manifest.externalReaders) await put(repo, file);
  await audit(repo);
  const base = await commit(repo);
  await put(repo, "README.md", "changed\n");
  const target = await commit(repo);
  return { repo, base, target };
}
