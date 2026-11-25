import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { waitForCodexWriters } from "../helpers/codex-late-writers.mjs";

// The Codex fixtures wait for a git child that `codex exec` left writing into
// its home before they remove it. This stands a late writer in for that child.
const skip = process.platform === "win32" ? "the Codex fixtures that wait are POSIX only" : false;

async function home(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "acc-late-writer-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A process whose command line names the directory, as `git -C <home>/.tmp/...` does.
function lateWriter(directory, milliseconds) {
  const target = path.join(directory, ".tmp", "plugins-clone-x", "plugins", "late");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { mkdir, writeFile } from "node:fs/promises";
    import path from "node:path";
    await new Promise(resolve => setTimeout(resolve, ${milliseconds}));
    await mkdir(path.dirname(process.argv[1]), { recursive: true });
    await writeFile(process.argv[1], "late plugin bytes");`, target], { stdio: "ignore" });
  return { child, target, exited: new Promise(resolve => child.once("exit", resolve)) };
}

test("the wait returns only after a late writer under the home has finished", { skip }, async t => {
  const directory = await home(t);
  const writer = lateWriter(directory, 800);
  await new Promise(resolve => setTimeout(resolve, 100));

  await waitForCodexWriters(directory, { timeoutMs: 20_000, pollMs: 50 });

  assert.equal(writer.child.exitCode, 0, "the writer finished before the wait returned");
  assert.ok((await stat(writer.target)).isFile());
});

test("a writer still running at the deadline fails with its command line", { skip }, async t => {
  const directory = await home(t);
  const writer = lateWriter(directory, 3_000);
  t.after(() => { writer.child.kill(); return writer.exited; });
  await new Promise(resolve => setTimeout(resolve, 100));

  await assert.rejects(waitForCodexWriters(directory, { timeoutMs: 300, pollMs: 50 }),
    error => error.message.includes("still write under") && error.message.includes(directory));
});

test("a home nothing writes under returns at once", { skip }, async t => {
  await waitForCodexWriters(await home(t), { timeoutMs: 1, pollMs: 1 });
});
