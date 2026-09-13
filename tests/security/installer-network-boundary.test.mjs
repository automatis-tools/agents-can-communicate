import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");

test("the actual hook does not load the explicit installation network module", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acc-no-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  const marker = path.join(root, "loaded"), witness = path.join(root, "hook-graph");
  const preload = path.join(root, "guard.mjs");
  await writeFile(preload, `import { registerHooks } from "node:module";
    import { writeFileSync } from "node:fs";
    registerHooks({ load(url, context, next) {
      if (url.endsWith("/hook-runner/src/runner.mjs")) writeFileSync(${JSON.stringify(witness)}, url);
      if (url.endsWith("/verified-download.mjs")) {
        writeFileSync(${JSON.stringify(marker)}, url);
        throw new Error("hook loaded installer networking");
      }
      return next(url, context);
    } });`);
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"),
    GIT_DIR: "", GIT_WORK_TREE: "", NODE_OPTIONS: "", PATH: path.dirname(process.execPath) };
  for (const key of Object.keys(env)) if (key.startsWith("ACC_")) delete env[key];
  Object.assign(env, { ACC_DATA_HOME: path.join(root, "data"), ACC_NO_UPDATE_CHECK: "1" });
  const result = run(process.execPath, ["--import", pathToFileURL(preload).href,
    path.join(repo, "bin/acc-hook.mjs"), "codex"], { cwd: project, env, timeout: 15_000 });
  result.child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit",
    session_id: "network-boundary-fixture", cwd: project, prompt: "continue" }));
  // Hooks fail open, so exit zero alone is not proof that the graph was safe.
  let childError;
  await result.catch(error => { childError = error; });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.match(await readFile(witness, "utf8").catch(() => ""), /\/hook-runner\/src\/runner\.mjs$/);
  assert.ifError(childError);
});
