import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// A hook runs in front of someone's turn. Reading the table is worth a few
// hundred milliseconds once per session and nothing at all if it is slow.
const DEFAULT_TIMEOUT_MS = 1_000;

const LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

/**
 * Every process on this machine, as pid -> parent and executable.
 *
 * Returns an empty map rather than throwing when the platform has no `ps`
 * (Windows) or the call fails. An empty table resolves no client, which is the
 * "nobody knows" answer the caller already handles.
 */
export async function readProcessTable({ run: exec = run,
  timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await exec("ps", ["-o", "pid=,ppid=,comm=", "-A"],
      { timeout: timeoutMs });
    const table = new Map();
    for (const line of stdout.split("\n")) {
      const match = LINE.exec(line);
      if (match === null) continue;
      table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3] });
    }
    return table;
  } catch {
    return new Map();
  }
}
