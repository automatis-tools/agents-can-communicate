// Exact immutable Git objects only. Failures have fixed diagnostics, never stderr/paths.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pushEnvironment } from "./push-targets.mjs";
const execute = promisify(execFile);
export const isOid = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const decode = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
export async function gitBytes(repo, args) {
  try {
    return (await execute("git", ["--no-replace-objects", "-C", repo, ...args], { encoding: "buffer", timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024, env: { ...pushEnvironment(), GIT_OPTIONAL_LOCKS: "0" } })).stdout;
  } catch { throw Error("git-facts-unavailable"); }
}
export const gitText = async (repo, args) => decode(await gitBytes(repo, args));
export async function resolveCommit(repo, oid) {
  if (!isOid(oid)) throw Error("target-oid-required");
  const commit = (await gitText(repo, ["rev-parse", "--verify", `${oid}^{commit}`])).trim();
  if (commit !== oid) throw Error("target-commit-required");
  const tree = (await gitText(repo, ["rev-parse", "--verify", `${commit}^{tree}`])).trim();
  if (!isOid(tree)) throw Error("target-tree-unavailable");
  return { commit, tree };
}
function fields(bytes) {
  const text = decode(bytes);
  if (!text) return [];
  if (!text.endsWith("\0")) throw Error("git-record-incomplete");
  return text.slice(0, -1).split("\0");
}
export function parseRawChanges(bytes) {
  const parts = fields(bytes);
  const changes = [];
  for (let index = 0; index < parts.length;) {
    const header = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([AMDT]|[RC](?:100|0?\d{1,2}))$/.exec(parts[index++]);
    if (!header) throw Error("git-record-unsupported");
    const [, old, next, , , code] = header;
    const status = code[0];
    const first = parts[index++];
    const second = ["R", "C"].includes(status) ? parts[index++] : first;
    if (!first || !second) throw Error("git-path-incomplete");
    changes.push({ status, oldPath: status === "A" ? null : first,
      newPath: status === "D" ? null : second,
      oldMode: old === "000000" ? null : old, newMode: next === "000000" ? null : next });
  }
  return changes;
}
export async function readTree(repo, tree) {
  if (!isOid(tree)) throw Error("tree-oid-required");
  return fields(await gitBytes(repo, ["ls-tree", "-r", "-z", "--full-tree", tree])).map(record => {
    const tab = record.indexOf("\t");
    const header = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(record.slice(0, tab));
    if (tab < 0 || !header || !record.slice(tab + 1)) throw Error("tree-record-unsupported");
    return { mode: header[1], type: header[2], oid: header[3], path: record.slice(tab + 1) };
  });
}
export async function treeBlob(repo, entries, file) {
  const entry = entries.find(entry => entry.path === file);
  if (!entry || entry.type !== "blob" || entry.mode !== "100644") throw Error("tree-blob-unavailable");
  return gitText(repo, ["cat-file", "blob", entry.oid]);
}
