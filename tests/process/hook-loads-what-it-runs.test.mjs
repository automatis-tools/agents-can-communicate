import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");

// A hook starts a process on every turn, and loading its modules was most of
// that start on Windows: 195 files, about a millisecond each on windows-latest,
// of which every other client's adapter, the command line and the installer
// were never run. A hook now loads its own client's adapter and the parts of
// the CLI and installer a hook calls.
test("a hook process loads its own adapter and none of the command line", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "acc-hook-loads-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const list = path.join(home, "loaded.json");
  const hooks = path.join(home, "count.mjs");
  await writeFile(hooks, `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const loaded = [];
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
process.on("exit", () => writeFileSync(${JSON.stringify(list)}, JSON.stringify(loaded)));
`);
  const pending = run(process.execPath, ["--import", pathToFileURL(hooks).href,
    path.join(repo, "bin", "acc-hook.mjs"), "codex"],
  { env: { ...process.env, ACC_DATA_HOME: path.join(home, "data") }, timeout: 60_000 });
  pending.child.stdin.end("{}");
  await pending.catch(error => error);
  const loaded = JSON.parse(await readFile(list, "utf8")).map(url => url.replaceAll("\\", "/"));
  const from = pkg => loaded.filter(url => url.includes(`/packages/${pkg}/`));

  for (const other of ["adapter-claude-code", "adapter-antigravity", "adapter-gemini-cli",
    "adapter-grok", "adapter-kimi"]) {
    assert.deepEqual(from(other), [], `a codex hook loaded ${other}`);
  }
  assert.notDeepEqual(from("adapter-codex"), [], "the hook never loaded its own adapter");
  for (const command of ["install-command.mjs", "doctor-command.mjs", "update-command.mjs",
    "main.mjs", "args.mjs"]) {
    assert.deepEqual(from("cli").filter(url => url.endsWith(`/${command}`)), [],
      `a hook loaded the CLI's ${command}`);
  }
  for (const part of ["detect.mjs", "apply.mjs", "plan.mjs"]) {
    assert.deepEqual(from("installer").filter(url => url.endsWith(`/${part}`)), [],
      `a hook loaded the installer's ${part}`);
  }
});
