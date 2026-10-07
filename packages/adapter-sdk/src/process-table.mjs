import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A hook runs in front of someone's turn. Reading the table is worth a few
// hundred milliseconds once per session and nothing at all if it is slow.
const DEFAULT_TIMEOUT_MS = 1_000;

const LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;
// A pid, then the whole rest of the line: a command line has spaces anywhere.
const ARGS_LINE = /^\s*(\d+)\s+(.+?)\s*$/;
// Command lines are long; measured at 231 KB for 1,137 processes on a desktop
// Mac, a quarter of execFile's default buffer.
const ARGS_BUFFER = 16 * 1024 * 1024;

// Deep enough for a client that wraps its hook in a shell and a launcher.
const WINDOWS_HOPS = 8;

async function posixTable({ run, timeoutMs }) {
  const options = { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true };
  const [tree, commandLines] = await Promise.all([
    run("ps", ["-o", "pid=,ppid=,comm=", "-A"], options).then(({ stdout }) => stdout, () => null),
    run("ps", ["-A", "-o", "pid=,args="], { ...options, maxBuffer: ARGS_BUFFER })
      .then(({ stdout }) => stdout, () => ""),
  ]);
  if (typeof tree !== "string") return new Map();
  const args = new Map();
  for (const line of String(commandLines).split("\n")) {
    const match = ARGS_LINE.exec(line);
    if (match !== null) args.set(Number(match[1]), match[2]);
  }
  const table = new Map();
  for (const line of tree.split("\n")) {
    const match = LINE.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    table.set(pid, { ppid: Number(match[2]), comm: match[3],
      ...(args.has(pid) ? { args: args.get(pid) } : {}) });
  }
  return table;
}

// Windows has no `ps` and no longer ships `wmic`. Win32_Process through CIM
// answers pid, parent, creation time and command line. A full scan took 1.07 s
// in Windows PowerShell 5.1 on a windows-latest runner, so the script asks only
// for the chain it needs, one filtered query per hop. The creation time goes
// out as a string: a FILETIME is larger than a double holds exactly.
const chainScript = (from, hops) => `$ErrorActionPreference = 'Stop'
$next = ${Number(from)}
$chain = New-Object System.Collections.ArrayList
for ($hop = 0; $hop -lt ${Number(hops)}; $hop++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$next" -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine
  if ($null -eq $p) { break }
  [void]$chain.Add([pscustomobject]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; start = $p.CreationDate.ToFileTimeUtc().ToString(); cmd = [string]$p.CommandLine })
  if ($p.ParentProcessId -eq 0 -or $p.ParentProcessId -eq $next) { break }
  $next = [int]$p.ParentProcessId
}
ConvertTo-Json -Compress -InputObject @($chain)`;

// PowerShell by absolute path only, so a PATH entry cannot stand in for it.
// PowerShell 7 is not part of Windows; where it is installed it answers faster
// (0.37 s against 1.07 s for a full scan, measured), and a missing one fails to
// spawn at once.
function powershellCandidates(env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const programs = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
  return [path.win32.join(programs, "PowerShell", "7", "pwsh.exe"),
    path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")];
}

// Windows Script Host reads the same chain through WMI in a quarter of the
// time: 145 ms against PowerShell's 580, and 258 against 1,080 with four hooks
// at once (windows-latest, measured), because it starts no .NET runtime. A
// machine can switch it off by policy; PowerShell then reads the chain.
const WMI_CHAIN = fileURLToPath(new URL("./windows-process-chain.wsf", import.meta.url));

// WMI's `yyyymmddHHMMSS.ffffff+UUU` - offset in minutes - as a FILETIME string,
// the form the PowerShell script prints.
function wmiFileTime(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(value ?? "");
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, micros, sign, offset] = match;
  const local = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour),
    Number(minute), Number(second));
  const utc = local - (sign === "+" ? 1 : -1) * Number(offset) * 60_000;
  return String((BigInt(utc) + 11_644_473_600_000n) * 10_000n + BigInt(micros) * 10n);
}

const chainOf = stdout => {
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(hop => (typeof hop?.created === "string"
    ? { ...hop, start: wmiFileTime(hop.created) } : hop));
};

async function windowsChain({ from, hops, run, timeoutMs, env }) {
  const deadline = Date.now() + timeoutMs;
  const options = () => ({ timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL",
    windowsHide: true, maxBuffer: ARGS_BUFFER });
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  try {
    const { stdout } = await run(path.win32.join(root, "System32", "cscript.exe"),
      ["//Nologo", WMI_CHAIN, String(Number(from)), String(Number(hops))], options());
    return chainOf(stdout);
  } catch {
    // Script Host is off or failed; PowerShell below.
  }
  const encoded = Buffer.from(chainScript(from, hops), "utf16le").toString("base64");
  for (const shell of powershellCandidates(env)) {
    if (Date.now() >= deadline) break;
    try {
      const { stdout } = await run(shell, ["-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], options());
      return chainOf(stdout);
    } catch {
      // Try the next shell; none left is the empty answer below.
    }
  }
  return [];
}

/**
 * Windows: one process - pid, parent, image name, creation time as a FILETIME
 * string (to the microsecond, as WMI keeps it) and command line - or null when
 * it cannot be read.
 */
export async function readWindowsProcess(pid, { run = execFileAsync, timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const [found] = await windowsChain({ from: pid, hops: 1, run, timeoutMs, env });
  return found?.pid === pid ? found : null;
}

async function windowsTable({ from, run, timeoutMs, env }) {
  const table = new Map();
  let child = null;
  for (const hop of await windowsChain({ from, hops: WINDOWS_HOPS, run, timeoutMs, env })) {
    if (!Number.isSafeInteger(hop?.pid) || typeof hop.name !== "string") break;
    // Windows never re-parents an orphan: its ppid can name a process that
    // died and whose number was reused. A parent created after its child is
    // exactly that, and nothing above it belongs to this chain.
    if (child !== null && !(BigInt(hop.start ?? "0") <= BigInt(child.start ?? "0"))) break;
    table.set(hop.pid, { ppid: hop.ppid, comm: hop.name,
      ...(typeof hop.cmd === "string" && hop.cmd !== "" ? { args: hop.cmd } : {}),
      ...(typeof hop.start === "string" ? { start: hop.start } : {}) });
    child = hop;
  }
  return table;
}

/**
 * Processes on this machine, as pid -> parent, executable and, when it could be
 * read, command line.
 *
 * POSIX reads the whole table with `ps`. Windows reads the chain from `from`
 * upward - the only part a hook asks about - with a creation time for each hop.
 * A failed read is an empty map, never an error: an empty table resolves no
 * client, which is the "nobody knows" answer every caller already handles.
 */
export async function readProcessTable({ platform = process.platform, from = process.pid,
  run = execFileAsync, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  if (platform === "win32") return windowsTable({ from, run, timeoutMs, env });
  return posixTable({ run, timeoutMs });
}

/**
 * Whether a process has exited and only waits for its parent to collect it -
 * the POSIX zombie, `ps` state `Z`. `kill(pid, 0)` succeeds for one and `ps`
 * still lists its start time, so a liveness check that stops there calls it
 * alive: on 2026-10-06 a stopped Codex daemon left as a zombie under Codex's
 * own pid-update-loop kept an ACC update blocked and its restart refused
 * (#280). True or false when `ps` answers; null when it does not. Windows has
 * no such state.
 */
export async function processIsZombie(pid, { platform = process.platform, run = execFileAsync,
  timeoutMs = 2_000 } = {}) {
  if (platform === "win32") return false;
  try {
    const { stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "stat="],
      { timeout: timeoutMs, env: { ...process.env, LC_ALL: "C" } });
    const state = String(stdout).trim();
    return state === "" ? null : state.startsWith("Z");
  } catch { return null; }
}

/**
 * The words one process was started with, or null when they cannot be read.
 *
 * POSIX splits `ps -o args=` on whitespace, as every caller did before. Windows
 * keeps one command-line string per process, split here the way the C runtime
 * splits it.
 */
export async function readProcessArgs(pid, { platform = process.platform, run = execFileAsync,
  timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, ps = "ps" } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    const [own] = await windowsChain({ from: pid, hops: 1, run, timeoutMs, env });
    return own?.pid === pid && typeof own.cmd === "string" && own.cmd !== ""
      ? splitWindowsCommandLine(own.cmd) : null;
  }
  try {
    const { stdout } = await run(ps, ["-o", "args=", "-p", String(pid)],
      { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true });
    const words = stdout.trim().split(/\s+/).filter(Boolean);
    return words.length > 0 ? words : null;
  } catch {
    return null;
  }
}

/**
 * Split a Windows command line into argv the way CommandLineToArgvW does:
 * whitespace separates words outside quotes; 2n backslashes before a quote are
 * n backslashes and the quote toggles quoting; 2n+1 are n backslashes and a
 * literal quote; backslashes elsewhere are literal.
 */
export function splitWindowsCommandLine(line) {
  const words = [];
  let word = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\") {
      let count = 0;
      while (line[index] === "\\") { count += 1; index += 1; }
      if (line[index] === "\"") {
        word += "\\".repeat(Math.floor(count / 2));
        if (count % 2 === 1) word += "\"";
        else quoted = !quoted;
      } else {
        word += "\\".repeat(count);
        index -= 1;
      }
      started = true;
    } else if (char === "\"") {
      quoted = !quoted;
      started = true;
    } else if ((char === " " || char === "\t") && !quoted) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}
