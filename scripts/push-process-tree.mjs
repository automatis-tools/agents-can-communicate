// Abort-only POSIX ownership discovery. ACC's existing batch runner creates a
// detached group, so killing npm's PGID alone cannot authorize checkout removal.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const terminationFailure = () => Object.assign(Error("owned process termination unconfirmed; checkout retained"),
  { code: "PUSH_TERMINATION_UNCONFIRMED" });

async function processTable() {
  // Numeric relations and state only: never inspect command lines/environment.
  const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { timeout: 2000 });
  const table = new Map();
  for (const line of stdout.trim().split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !fields.slice(0, 3).every(value => /^\d+$/.test(value))) throw terminationFailure();
    const [pid, parent, group] = fields.slice(0, 3).map(Number);
    if (!pid || !group || table.has(pid)) throw terminationFailure();
    table.set(pid, { pid, parent, group, state: fields[3] });
  }
  return table;
}

// The optional system seam exercises denied/incomplete OS observations; native
// process ownership remains covered by the unchanged real runTestBatch fixture.
export async function stopPushProcessTree(pid, { snapshot = processTable, kill = process.kill, wait = pause } = {}) {
  const owned = new Map();
  try {
    if (!Number.isInteger(pid) || pid <= 0) throw terminationFailure();
    // Freeze our fresh spawn's group before observing relations. Killing the
    // parent first would reparent its detached children and lose ownership.
    kill(-pid, "SIGSTOP");
    let frozen = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const table = await snapshot();
      const root = table.get(pid);
      if (!root || root.group !== pid) throw terminationFailure();
      // Same-group children may already have been adopted by init; the group
      // was created by our spawn and has just been frozen as a whole.
      const related = new Map([...table].filter(([, row]) => row.group === pid));
      for (let changed = true; changed;) {
        changed = false;
        for (const row of table.values()) {
          if (!related.has(row.pid) && related.has(row.parent)) {
            related.set(row.pid, row); changed = true;
          }
        }
      }
      // A vanished/reparented observed child could have left an unseen batch.
      // A zombie parent is equally uncertain. Never delete on that evidence.
      for (const previous of owned.values()) {
        const current = related.get(previous.pid);
        if (!current || current.parent !== previous.parent || current.group !== previous.group) throw terminationFailure();
      }
      if ([...related.values()].some(row => /Z/.test(row.state))) throw terminationFailure();
      frozen = [...related.values()].every(row => /T/.test(row.state));
      for (const row of related.values()) {
        owned.set(row.pid, row);
        if (!/T/.test(row.state)) kill(row.pid, "SIGSTOP");
      }
      if (frozen) break;
      await wait(10);
    }
    if (!frozen) throw terminationFailure();
    // Every observed ancestor is now stopped; none can create or reparent a
    // new worker. Terminate only these frozen, proven owned PIDs.
    for (const row of [...owned.values()].reverse()) kill(row.pid, "SIGKILL");
    // Wait for reaping where available. Zombies cannot read a removed tree;
    // some container init processes do not promptly reap adopted children.
    for (let attempt = 0; attempt < 100; attempt++) {
      const table = await snapshot();
      const remaining = [...owned.keys()].map(id => table.get(id)).filter(Boolean);
      if (!remaining.length) return null;
      if (remaining.every(row => /Z/.test(row.state)) && attempt >= 10) return null;
      await wait(20);
    }
    throw terminationFailure();
  } catch {
    // Ownership is now uncertain: do not signal stale PIDs (or a possibly
    // reused group). Retain both checkout and any stopped processes for recovery.
    return terminationFailure();
  }
}
