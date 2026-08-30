import path from "node:path";

// Deep enough for a client that wraps its hook in a shell and a launcher, short
// enough that a table which disagrees with itself cannot spin.
const MAX_HOPS = 16;

/**
 * The pid of the client this hook is running for, or null when nobody knows.
 *
 * The hook is not the client's child. Measured on macOS, a process spawned by
 * Claude Code has parent `/bin/zsh` and grandparent `claude`, so `process.ppid`
 * names a shell that dies with the hook. Walking until the adapter's own
 * declared binary appears is what makes the answer specific rather than a guess
 * about which ancestors are "real".
 *
 * Null is a first-class answer: it means judge this session by age alone.
 */
export function resolveClientPid({ table, from, command, maxHops = MAX_HOPS }) {
  const seen = new Set();
  let current = from;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const entry = table.get(current);
    if (entry === undefined || seen.has(current)) return null;
    seen.add(current);
    // `ps` reports some entries bare (`claude`) and some with a path
    // (`/bin/zsh`), so the comparison has to be on the basename.
    if (path.basename(entry.comm) === command) return current;
    if (entry.ppid === current || entry.ppid <= 1) return null;
    current = entry.ppid;
  }
  return null;
}
