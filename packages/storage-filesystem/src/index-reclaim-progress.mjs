import { createHash } from "node:crypto";
import path from "node:path";
import { publishAtomic } from "./atomic-json.mjs";
import { withRegularNoFollow } from "./safe-file.mjs";

const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const file = root => path.join(root, "indexes/v1/reclaim.json");
const fresh = () => ({ version: 1, pending: [], visited: [], cursor: null, done: false });
const valid = state => state && Object.keys(state).sort().join(",") === "cursor,done,pending,version,visited"
  && state.version === 1 && typeof state.done === "boolean"
  && [state.pending, state.visited].every(items => Array.isArray(items) && items.every(hash))
  && (state.cursor === null || /^[a-f0-9]{64}\.json$/.test(state.cursor))
  && (!state.done || state.pending.length === 0);

// This is optional, checksummed bookkeeping, never primary authority. Atomic
// replacement means process death leaves the previous complete checkpoint;
// lost/torn bytes restart marking before any further deletion. No fsync is due.
export async function readReclaimProgress(root) {
  try {
    const bytes = await withRegularNoFollow(file(root), root, "r", (handle, stat) =>
      stat.size > 64 * 1024 * 1024 ? null : handle.readFile());
    if (bytes === null) return fresh();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!valid(value.state) || value.sha256 !== digest(JSON.stringify(value.state))) return fresh();
    return value.state.done ? fresh() : value.state;
  } catch { return fresh(); }
}

export async function writeReclaimProgress(paths, root, state, deadlineAt) {
  const body = JSON.stringify(state);
  await publishAtomic(file(root), Buffer.from(JSON.stringify({ state, sha256: digest(body) }) + "\n"), {
    root, tmpDir: paths.tmp, stageDir: paths.stage, replace: true, durability: "none", deadlineAt,
  });
}
