import assert from "node:assert/strict";
import test from "node:test";

import { resolveExecutable, runExecutable } from "../src/executables.mjs";

const disk = files => async file => files.includes(file);

// Measured on windows-latest: npm installs `codex.cmd`, `codex.ps1` and an
// extensionless `codex` shell script into its prefix. Joining the bare name onto
// each PATH entry found the shell script, which Windows cannot run, or nothing.
test("windows: a command is found through PATHEXT, a real .exe before a .cmd shim", async () => {
  const exists = disk(["C:\\npm\\prefix\\codex", "C:\\npm\\prefix\\codex.cmd",
    "C:\\Users\\dana\\.local\\bin\\claude.exe", "C:\\Tools\\claude.cmd"]);
  const options = { platform: "win32", pathExt: ".COM;.EXE;.BAT;.CMD;.VBS;.JS", exists,
    pathEnv: "C:\\npm\\prefix;C:\\Users\\dana\\.local\\bin;C:\\Tools" };
  assert.equal(await resolveExecutable("codex", options), "C:\\npm\\prefix\\codex.cmd");
  assert.equal(await resolveExecutable("claude", options), "C:\\Users\\dana\\.local\\bin\\claude.exe");
  assert.equal(await resolveExecutable("gemini", options), null);
});

test("windows: an excluded directory is skipped whatever its case", async () => {
  const exists = disk(["C:\\state\\bin\\claude.cmd", "C:\\real\\claude.exe"]);
  assert.equal(await resolveExecutable("claude", { platform: "win32", exists,
    pathEnv: "C:\\STATE\\bin;C:\\real", exclude: ["c:\\state\\bin"] }), "C:\\real\\claude.exe");
});

test("posix: the first executable of that exact name", async () => {
  const exists = disk(["/opt/bin/codex"]);
  assert.equal(await resolveExecutable("codex", { platform: "darwin", exists,
    pathEnv: "/usr/bin:/opt/bin" }), "/opt/bin/codex");
});

test("windows: a .cmd shim runs through cmd.exe with a command line ACC quotes", async () => {
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return { stdout: "0.159.2" }; };
  await runExecutable("C:\\npm\\prefix\\codex.cmd", ["--version"], { timeout: 1000 },
    { platform: "win32", run, env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } });
  assert.deepEqual(calls[0].file, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(calls[0].args, ["/d", "/s", "/c", "\"\"C:\\npm\\prefix\\codex.cmd\" \"--version\"\""]);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 1000);
});

test("windows: an argument cmd.exe would expand is refused, not escaped", async () => {
  const run = async () => ({ stdout: "" });
  for (const word of ["%PATH%", "a&b", "a|b", "\"x\"", "a^b", "!x!"]) {
    await assert.rejects(runExecutable("C:\\x\\tool.cmd", [word], {}, { platform: "win32", run }),
      { code: "EINVAL" }, word);
  }
});

test("an .exe, and anything on POSIX, runs directly", async () => {
  const calls = [];
  const run = async (file, args) => { calls.push([file, args]); return { stdout: "" }; };
  await runExecutable("C:\\x\\claude.exe", ["--version"], {}, { platform: "win32", run });
  await runExecutable("/opt/bin/codex", ["--version"], {}, { platform: "darwin", run });
  assert.deepEqual(calls, [["C:\\x\\claude.exe", ["--version"]], ["/opt/bin/codex", ["--version"]]]);
});

// process.env ignores case on Windows, but a copy of it does not, and Windows
// usually spells the variable `Path`.
test("the PATH of an environment copy is found whatever its case", async () => {
  const { pathOf } = await import("../src/executables.mjs");
  assert.equal(pathOf({ Path: "C:\\bin" }), "C:\\bin");
  assert.equal(pathOf({ PATH: "/usr/bin" }), "/usr/bin");
  assert.equal(pathOf({}), "");
});

test("an absolute command is used as it is, on either platform", async () => {
  const exists = disk(["C:\\Tools\\node.exe", "/opt/bin/codex"]);
  assert.equal(await resolveExecutable("C:\\Tools\\node.exe", { platform: "win32", exists,
    pathEnv: "C:\\Windows" }), "C:\\Tools\\node.exe");
  assert.equal(await resolveExecutable("C:\\Tools\\node", { platform: "win32", exists,
    pathEnv: "C:\\Windows" }), "C:\\Tools\\node.exe");
  assert.equal(await resolveExecutable("/opt/bin/codex", { platform: "darwin", exists,
    pathEnv: "/usr/bin" }), "/opt/bin/codex");
  assert.equal(await resolveExecutable("C:\\Tools\\missing.exe", { platform: "win32", exists,
    pathEnv: "C:\\Windows" }), null);
});
