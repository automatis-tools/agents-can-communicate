import assert from "node:assert/strict";
import test from "node:test";

import { readProcessArgs, readProcessTable, splitWindowsCommandLine }
  from "../src/process-table.mjs";

// What the Windows script prints: the chain from the asking process upward,
// one object per hop, creation time as a FILETIME string. Shapes recorded on a
// windows-latest runner (probe round two), trimmed.
const chain = [
  { pid: 3504, ppid: 7072, name: "node.exe", start: "134352177138959680",
    cmd: "\"C:\\hostedtoolcache\\windows\\node\\24.21.0\\x64\\node.exe\" hook.mjs" },
  { pid: 7072, ppid: 6660, name: "pwsh.exe", start: "134352177136121740",
    cmd: "\"C:\\Program Files\\PowerShell\\7\\pwsh.EXE\" -NoProfile -Command x" },
  { pid: 6660, ppid: 844, name: "claude.exe", start: "134352177030323440",
    cmd: "\"C:\\Users\\dana\\.local\\bin\\claude.exe\"" },
];

const powershell = output => {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    return { stdout: JSON.stringify(output), stderr: "" };
  };
  return { run, calls };
};

test("windows: the table is the asking process's chain of parents", async () => {
  const { run, calls } = powershell(chain);
  const table = await readProcessTable({ platform: "win32", from: 3504, run,
    env: { SystemRoot: "C:\\Windows", PATH: "" } });

  assert.deepEqual([...table.keys()], [3504, 7072, 6660]);
  assert.deepEqual(table.get(6660), { ppid: 844, comm: "claude.exe",
    args: "\"C:\\Users\\dana\\.local\\bin\\claude.exe\"", start: "134352177030323440" });
  // One call, to Windows Script Host, with a script that ships in the package.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "C:\\Windows\\System32\\cscript.exe");
  assert.deepEqual(calls[0].args.slice(0, 1), ["//Nologo"]);
  assert.match(calls[0].args[1], /windows-process-chain\.wsf$/);
  assert.deepEqual(calls[0].args.slice(2), ["3504", "8"]);
});

// Measured on windows-latest: WMI through Windows Script Host answered the chain
// in 145 ms, PowerShell in 580; four at once, 258 ms against 1,080. WMI gives a
// creation time as `yyyymmddHHMMSS.ffffff` with the offset in minutes.
test("windows: WMI's creation time becomes the same FILETIME whatever its offset", async () => {
  const at = (created, pid, ppid) => ({ pid, ppid, name: "node.exe", created, cmd: "node" });
  const { run } = powershell([at("20260930145555.548253+000", 20, 10),
    at("20260930095555.548250-300", 10, 5)]);
  const table = await readProcessTable({ platform: "win32", from: 20, run,
    env: { SystemRoot: "C:\\Windows" } });
  const ticks = (BigInt(Date.UTC(2026, 8, 30, 14, 55, 55)) + 11644473600000n) * 10000n;
  assert.equal(table.get(20).start, String(ticks + 5482530n));
  assert.equal(table.get(10).start, String(ticks + 5482500n));
});

// Windows Script Host can be switched off by policy, and it prints so and fails.
test("windows: where Windows Script Host is off, PowerShell reads the chain", async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push(file);
    if (/cscript\.exe$/i.test(file)) throw Object.assign(new Error("access is disabled"), { code: 1 });
    return { stdout: JSON.stringify(chain), stderr: "" };
  };
  const table = await readProcessTable({ platform: "win32", from: 3504, run,
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" } });
  assert.deepEqual([...table.keys()], [3504, 7072, 6660]);
  assert.deepEqual(calls, ["C:\\Windows\\System32\\cscript.exe",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe"]);
});

test("windows: this process's own chain is read on this machine",
  { skip: process.platform !== "win32" && "the chain is read through WMI only on Windows" },
  async () => {
    const table = await readProcessTable({ timeoutMs: 10_000 });
    assert.equal(table.get(process.pid)?.comm.toLowerCase(), "node.exe", JSON.stringify([...table]));
    assert.equal(table.get(process.pid).ppid, process.ppid);
    assert.equal(table.has(process.ppid), true, "the parent is missing from the chain");
    assert.match(table.get(process.pid).start, /^\d{17,18}$/);
  });

test("windows: a parent created after its child is a reused pid and ends the chain", async () => {
  const reused = [...chain];
  reused[2] = { ...chain[2], start: "134352177200000000" };
  const { run } = powershell(reused);
  const table = await readProcessTable({ platform: "win32", from: 3504, run,
    env: { SystemRoot: "C:\\Windows", PATH: "" } });

  assert.deepEqual([...table.keys()], [3504, 7072]);
});

test("windows: one object is still a chain", async () => {
  const { run } = powershell(chain[0]);
  const table = await readProcessTable({ platform: "win32", from: 3504, run,
    env: { SystemRoot: "C:\\Windows", PATH: "" } });
  assert.deepEqual([...table.keys()], [3504]);
});

test("windows: a failed or unreadable call is the empty answer, not an error", async () => {
  const failing = async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); };
  assert.equal((await readProcessTable({ platform: "win32", run: failing,
    env: { SystemRoot: "C:\\Windows" } })).size, 0);
  const garbled = async () => ({ stdout: "not json", stderr: "" });
  assert.equal((await readProcessTable({ platform: "win32", run: garbled,
    env: { SystemRoot: "C:\\Windows" } })).size, 0);
});

test("windows: a process's arguments are its command line split the way Windows splits it", async () => {
  const { run } = powershell([{ pid: 9, ppid: 1, name: "codex.exe", start: "1",
    cmd: "\"C:\\Program Files\\Codex\\codex.exe\" --search -c \"model=\\\"o3\\\"\"" }]);
  assert.deepEqual(await readProcessArgs(9, { platform: "win32", run,
    env: { SystemRoot: "C:\\Windows" } }),
  ["C:\\Program Files\\Codex\\codex.exe", "--search", "-c", "model=\"o3\""]);
});

test("the Windows command-line split follows CommandLineToArgvW", () => {
  assert.deepEqual(splitWindowsCommandLine("a b  c"), ["a", "b", "c"]);
  assert.deepEqual(splitWindowsCommandLine("\"a b\" c"), ["a b", "c"]);
  assert.deepEqual(splitWindowsCommandLine("a\\\\b c"), ["a\\\\b", "c"]);
  assert.deepEqual(splitWindowsCommandLine("\"a\\\\\" b"), ["a\\", "b"]);
  assert.deepEqual(splitWindowsCommandLine("a\\\"b"), ["a\"b"]);
  assert.deepEqual(splitWindowsCommandLine("\"\" x"), ["", "x"]);
  assert.deepEqual(splitWindowsCommandLine(""), []);
});

test("posix: the table and arguments still come from ps", async () => {
  const run = async (file, args) => {
    assert.equal(file, "ps");
    if (args.includes("pid=,ppid=,comm=")) return { stdout: "  1   0 launchd\n 100   1 claude\n" };
    if (args.includes("pid=,args=")) return { stdout: "  1 /sbin/launchd\n 100 claude --resume\n" };
    return { stdout: "claude --resume\n" };
  };
  const table = await readProcessTable({ platform: "darwin", run });
  assert.deepEqual(table.get(100), { ppid: 1, comm: "claude", args: "claude --resume" });
  assert.deepEqual(await readProcessArgs(100, { platform: "darwin", run }), ["claude", "--resume"]);
});
