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
  // The timeout is ACC's own, below: execFile's would wait for the batch's child.
  assert.equal(calls[0].options.timeout, undefined);
});

// cmd.exe starts the batch file's program as a child of its own. execFile's
// timeout kills cmd.exe and then waits for the pipes to close, which that child
// still holds, so a hung `claude.cmd --version` outlived its probe's limit.
test("windows: a .cmd that outlives its timeout is stopped with everything it started", async () => {
  const destroyed = [];
  const stream = name => ({ destroy: () => { destroyed.push(name); } });
  const run = () => Object.assign(new Promise(() => {}),
    { child: { pid: 4242, exitCode: null, signalCode: null, stdout: stream("stdout"),
      stderr: stream("stderr") } });
  const killed = [];
  const started = Date.now();
  const outcome = runExecutable("C:\\npm\\prefix\\claude.cmd", ["--version"], { timeout: 50 },
    { platform: "win32", run, env: {}, killTree: pid => { killed.push(pid); } });
  assert.equal(outcome.child.pid, 4242);
  await assert.rejects(outcome, { code: "ETIMEDOUT", killed: true });
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(killed, [4242]);
  assert.deepEqual(destroyed.sort(), ["stderr", "stdout"]);
});

test("windows: a hung .cmd client is stopped at its timeout, with its node child",
  { skip: process.platform !== "win32" && "cmd.exe runs a .cmd only on Windows" }, async t => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { writeFakeClient } = await import("../../../tests/helpers/fake-client.mjs");
    const directory = await mkdtemp(path.join(tmpdir(), "acc-hung-cmd-"));
    t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10 }));
    const pidFile = path.join(directory, "pid");
    const file = await writeFakeClient(directory, "hung", { script:
      `import { writeFileSync } from "node:fs";\n`
      + `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
      + "setTimeout(() => {}, 30000);\n" });
    const started = Date.now();
    await assert.rejects(runExecutable(file, ["--version"], { timeout: 3_000 }),
      { code: "ETIMEDOUT" });
    assert.ok(Date.now() - started < 8_000, `the probe took ${Date.now() - started}ms`);
    const pid = Number(await readFile(pidFile, "utf8"));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const deadline = Date.now() + 5_000; alive() && Date.now() < deadline;) {
      await new Promise(resolve => { setTimeout(resolve, 100); });
    }
    assert.equal(alive(), false, "the node the .cmd started outlived the probe");
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

// Measured on windows-latest: a copy of process.env keeps `Path`, a caller's
// environment names `PATH`, and a plain spread kept both, so the lookup read the
// machine's PATH and never found the caller's client.
test("windows: an environment laid over another replaces a variable whatever its case", async () => {
  const { mergeEnv, pathOf } = await import("../src/executables.mjs");
  const merged = mergeEnv({ Path: "C:\\Windows", ComSpec: "cmd" }, { PATH: "C:\\stub" }, "win32");
  assert.equal(pathOf(merged), "C:\\stub");
  assert.equal(merged.ComSpec, "cmd");
  assert.deepEqual(mergeEnv({ Path: "/a" }, { PATH: "/b" }, "linux"), { Path: "/a", PATH: "/b" });
});

// cmd.exe may have exited just before the timeout, and its pid can already
// belong to another process: taskkill /T would end that one and its tree.
test("windows: a .cmd that already exited at the timeout has nothing killed", async () => {
  const run = () => Object.assign(new Promise(() => {}),
    { child: { pid: 4343, exitCode: 0, signalCode: null, stdout: { destroy() {} },
      stderr: { destroy() {} } } });
  const killed = [];
  await assert.rejects(runExecutable("C:\\npm\\prefix\\claude.cmd", ["--version"], { timeout: 20 },
    { platform: "win32", run, env: {}, killTree: pid => { killed.push(pid); } }), { code: "ETIMEDOUT" });
  assert.deepEqual(killed, []);
});
