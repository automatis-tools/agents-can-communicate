// Synthetic repositories execute real Node tests and npm ci, avoiding recursive
// copies/runs of ACC's full suite while retaining the pushed-content oracle.
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// Test teardown only: signals are asynchronous. Observe recorded fixture PIDs
// dead (or zombie, unable to read bytes) before removing their retained tree.
export async function waitForOwnedProcessExit(pids) {
  const ids = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
  if (!ids.length) return;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { stdout } = await run("ps", ["-p", ids.join(","), "-o", "pid=,stat="]).catch(error => {
      if (error.code === 1) return { stdout: error.stdout ?? "" };
      throw error;
    });
    if (!stdout.trim() || stdout.trim().split("\n").every(line => /Z/.test(line.trim().split(/\s+/)[1]))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("owned fixture process teardown remained live");
}
export const repo = path.resolve(import.meta.dirname, "../..");
export const pushScript = process.env.ACC_PUSH_TEST_DRIVER ?? path.join(repo, "scripts/validate-push.mjs");
export function cleanEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|QUARANTINE_PATH)$/i.test(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  return env;
}
export async function fixture(t, format = "sha1") {
  const base = await mkdtemp(path.join(tmpdir(), "acc-push-fixture-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo");
  const env = cleanEnv();
  await run("git", ["init", "-q", "-b", "main", `--object-format=${format}`, root], { env });
  const git = args => run("git", ["-C", root, ...args], { env });
  await git(["config", "core.hooksPath", path.join(base, "no-hooks")]);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "push-fixture", version: "1.0.0",
    type: "module", scripts: { test: "node --test target.test.mjs" } }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ name: "push-fixture", version: "1.0.0",
    lockfileVersion: 3, packages: { "": { name: "push-fixture", version: "1.0.0" } } }));
  await writeFile(path.join(root, "module.mjs"), "export {};\n");
  await writeFile(path.join(root, "target.test.mjs"), "import './module.mjs'; console.log('actual target passed');\n");
  const oid = async () => (await git(["rev-parse", "HEAD"])).stdout.trim();
  const commit = async (message, empty = false) => {
    await git(["add", "-A"]);
    await git(["commit", "-q", ...(empty ? ["--allow-empty"] : []), "-m", message]);
    return oid();
  };
  await commit("fixture start");
  return { base, root, env, git, oid, commit,
    read: (file, cwd = root) => readFile(path.join(cwd, file), "utf8"),
    remove: file => rm(path.join(root, file), { force: true }),
    exists: file => access(file).then(() => true, () => false) };
}
export function refLine(oid, name = "main", base = "0".repeat(oid.length)) {
  return `refs/heads/main ${oid} refs/heads/${name} ${base}`;
}
export function invokePush(f, input, script = pushScript) {
  return new Promise((resolve, reject) => {
    const child = script.endsWith(".mjs")
      ? spawn(process.execPath, [script, "--remote", "origin"], { cwd: f.root, env: f.env })
      : spawn("sh", [script, "origin"], { cwd: f.root, env: f.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(`${input}\n`);
  });
}
