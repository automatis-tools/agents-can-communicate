// The attribution gate is exercised through its real entry points: the commit-msg
// hook in a scratch repository, the pre-push hook with a stub npm standing in for
// the suite, and the two CLI modes the Lint job runs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const script = path.join(repo, "scripts", "check-commit-attribution.mjs");
const hooks = path.join(repo, ".githooks");

const ATTRIBUTED = {
  "a Claude co-author trailer":
    "fix: x\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>\n",
  "the Anthropic address under another name": "fix: x\n\nco-authored-by: Assistant <noreply@anthropic.com>\n",
  "a session trailer": "fix: x\n\nClaude-Session: https://claude.ai/code/session_01ABC\n",
  "a generated-with footer": "docs: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n",
};
const CLEAN = {
  "the product name in a subject": "feat: deliver peer messages into Claude Code sessions\n",
  "a human co-author": "fix: x\n\nCo-Authored-By: Mykola Maksymenko <maksymenko.ml@gmail.com>\n",
  "claude.ai without a session link": "docs: sign in at claude.ai before the capture\n",
};
const GIT_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_QUARANTINE_PATH"];

// Scratch repositories ignore the machine's own git configuration, global hooks
// included, so a refusal here can only come from this repository's gate.
function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", ...extra };
  for (const name of GIT_VARIABLES) delete env[name];
  return env;
}

async function attempt(file, args, options) {
  try {
    const { stdout, stderr } = await run(file, args, options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function scratch(t, extraEnv) {
  const base = await mkdtemp(path.join(tmpdir(), "acc-attribution-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = gitEnv(extraEnv);
  const root = path.join(base, "work");
  const git = args => attempt("git", ["-C", root, ...args], { env });
  await run("git", ["init", "-q", "-b", "main", root], { env });
  await run("git", ["init", "-q", "--bare", path.join(base, "remote.git")], { env });
  await git(["remote", "add", "origin", path.join(base, "remote.git")]);
  await git(["config", "core.hooksPath", hooks]);
  await writeFile(path.join(root, "a.mjs"), "export {};\n");
  await git(["add", "a.mjs"]);
  await git(["commit", "-q", "-m", "chore: start"]);
  let serial = 0;
  const commit = async (message, ...flags) => {
    serial += 1;
    await writeFile(path.join(root, `change-${serial}.txt`), `${serial}\n`);
    await git(["add", "-A"]);
    const file = path.join(base, `message-${serial}`);
    await writeFile(file, message);
    return git(["commit", "-q", ...flags, "-F", file]);
  };
  return { base, root, env, git, commit };
}

for (const [name, message] of Object.entries(ATTRIBUTED)) {
  test(`the commit-msg hook refuses ${name}`, async t => {
    const { git, commit } = await scratch(t);
    const before = (await git(["rev-parse", "HEAD"])).stdout;
    const result = await commit(message);
    assert.notEqual(result.code, 0, "an attributed message was committed");
    assert.match(result.stderr, /Claude attribution/);
    assert.equal((await git(["rev-parse", "HEAD"])).stdout, before);
  });
}

for (const [name, message] of Object.entries(CLEAN)) {
  test(`the commit-msg hook accepts ${name}`, async t => {
    const { commit } = await scratch(t);
    const result = await commit(message);
    assert.equal(result.code, 0, result.stderr);
  });
}

// git hands commit-msg the file before its own cleanup, so the hook sees comment
// lines and, under `git commit -v`, the staged diff below the scissors line.
test("a trailer in a comment or in the `git commit -v` diff is not the message", async t => {
  const { base, root, git } = await scratch(t);
  await writeFile(path.join(root, "fixture.txt"), Object.values(ATTRIBUTED).join(""));
  await git(["add", "fixture.txt"]);
  const editor = path.join(base, "editor.sh");
  await writeFile(editor, "#!/bin/sh\n"
    + 'printf "test: keep trailer strings as fixture data\\n\\n# Claude-Session: https://claude.ai/code/session_x\\n"'
    + ' | cat - "$1" > "$1.new"\nmv "$1.new" "$1"\n');
  await chmod(editor, 0o755);
  const result = await attempt("git", ["-C", root, "commit", "-q", "-v"],
    { env: gitEnv({ GIT_EDITOR: editor }) });
  assert.equal(result.code, 0, result.stderr);
});

test("the pre-push hook refuses attributed commits before the suite runs", async t => {
  const stub = await mkdtemp(path.join(tmpdir(), "acc-attribution-npm-"));
  t.after(() => rm(stub, { recursive: true, force: true }));
  await writeFile(path.join(stub, "npm"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(stub, "npm"), 0o755);
  const PATH = [stub, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter);
  const { git, commit } = await scratch(t, { PATH });

  assert.equal((await git(["push", "-q", "origin", "main"])).code, 0, "a clean first push was refused");
  assert.equal((await commit(ATTRIBUTED["a session trailer"], "--no-verify")).code, 0);
  assert.equal((await commit("chore: clean on top\n")).code, 0);
  const refused = await git(["push", "-q", "origin", "main"]);
  assert.notEqual(refused.code, 0, "a push carrying an attributed commit went through");
  assert.match(refused.stderr, /fix: x/);
  const published = (await git(["ls-remote", "origin", "refs/heads/main"])).stdout.split("\t")[0];
  assert.equal(published, (await git(["rev-parse", "HEAD~2"])).stdout.trim());

  const branch = await git(["push", "-q", "origin", "HEAD:refs/heads/feature"]);
  assert.notEqual(branch.code, 0, "a new branch carrying an attributed commit went through");
});

test("the Lint mode refuses attributed history and accepts a clean one", async t => {
  const { root, env, commit } = await scratch(t);
  const clean = await attempt(process.execPath, [script, "--history", "HEAD"], { cwd: root, env });
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal((await commit(ATTRIBUTED["a generated-with footer"], "--no-verify")).code, 0);
  const dirty = await attempt(process.execPath, [script, "--history", "HEAD"], { cwd: root, env });
  assert.equal(dirty.code, 1);
  assert.match(dirty.stderr, /docs: x/);
});

test("the Lint mode checks a pull request description handed over in the environment", async t => {
  const check = body => attempt(process.execPath, [script, "--text-env", "PR_BODY"],
    { env: { ...process.env, PR_BODY: body } });
  for (const message of Object.values(ATTRIBUTED)) assert.equal((await check(message)).code, 1, message);
  for (const message of Object.values(CLEAN)) assert.equal((await check(message)).code, 0, message);
  assert.equal((await check("")).code, 0, "an empty description is clean");
});

test("an unknown mode is a usage error, not a pass", async () => {
  const result = await attempt(process.execPath, [script, "--everything"], {});
  assert.equal(result.code, 2);
});
