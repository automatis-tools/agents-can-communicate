import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// A hook runs in front of someone's turn. Reading the table is worth a few
// hundred milliseconds once per session and nothing at all if it is slow.
const DEFAULT_TIMEOUT_MS = 1_000;

const LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;
// A pid, then the whole rest of the line: a command line has spaces anywhere.
const ARGS_LINE = /^\s*(\d+)\s+(.+?)\s*$/;
// Command lines are long; measured at 231 KB for 1,137 processes on a desktop
// Mac, a quarter of execFile's default buffer.
const ARGS_BUFFER = 16 * 1024 * 1024;

/**
 * Every process on this machine, as pid -> parent, executable and, when it
 * could be read, command line.
 *
 * Returns an empty map rather than throwing when the platform has no `ps`
 * (Windows) or the call fails. An empty table resolves no client, which is the
 * "nobody knows" answer the caller already handles. The command lines are read
 * at the same time and within the same timeout; they only name a client that
 * is a script, so when that read fails every entry keeps what it had before.
 */
export async function readProcessTable({ run: exec = run,
  timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const options = { timeout: timeoutMs, killSignal: "SIGKILL" };
  const [tree, commandLines] = await Promise.all([
    exec("ps", ["-o", "pid=,ppid=,comm=", "-A"], options).then(({ stdout }) => stdout, () => null),
    exec("ps", ["-A", "-o", "pid=,args="], { ...options, maxBuffer: ARGS_BUFFER })
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
