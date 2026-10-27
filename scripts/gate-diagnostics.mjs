// Optional operational evidence has a closed schema: never serialize environment
// values, errors, command output or absolute local paths into a run manifest.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const reasons = new Set(["hit", "absent", "expired", "invalid", "inputs-uncertain", "ci-disabled", "scope-mismatch"]);
const events = new Set(["fingerprint", "cache-lookup", "packed-template", "batch-execution", "cleanup", "total", "receipt-persistence"]);
const results = new Set(["passed", "failed", "reused", "available", "inputs-uncertain", "ci-disabled", "hit", "absent",
  "expired", "invalid", "scope-mismatch", "fingerprint-changed", "observation-changed", "eligible", "ineligible", "saved", "unavailable"]);
const nonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const oid = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const relativeFile = value => typeof value === "string" && value.length > 0
  && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.includes("\\")
  && value.split("/").every(part => part !== ".." && part !== "." && part !== "");

function timing(record) {
  const output = { schema: 1 };
  const validators = { event: value => events.has(value), durationMs: nonnegative, commit: oid, tree: oid,
    platform: value => ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"].includes(value),
    node: value => typeof value === "string" && /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value),
    scope: value => ["full", "docs"].includes(value), planDigest: sha256, selectionDigest: sha256,
    shard: value => typeof value === "string" && /^[1-9]\d*\/[1-9]\d*$/.test(value),
    fileCount: integer, concurrency: integer, fsyncMode: value => ["real", "skipped"].includes(value),
    result: value => results.has(value) };
  for (const [key, valid] of Object.entries(validators)) if (valid(record[key])) output[key] = record[key];
  return output;
}

// Reports are optional evidence, never an authority for the worker exit code.
export async function readGateTimings(report) {
  const records = [];
  let complete = true;
  try {
    const lines = (await readFile(report, "utf8")).split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) complete = false;
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item === null || typeof item.file !== "string" || item.file.length === 0
          || !nonnegative(item.durationMs) || typeof item.success !== "boolean") {
          complete = false;
          continue;
        }
        records.push({ file: item.file, durationMs: item.durationMs, success: item.success });
      } catch { complete = false; }
    }
  } catch { complete = false; }
  return { records, complete };
}

export async function gateIdentity(repo) {
  try {
    const { stdout } = await run("git", ["-C", repo, "rev-parse", "HEAD", "HEAD^{tree}"], { timeout: 2000 });
    const [commit, tree] = stdout.trim().split(/\r?\n/);
    return oid(commit) && oid(tree) ? { commit, tree } : {};
  } catch { return {}; }
}

export async function writeGateDiagnostic(destination, record) {
  if (!destination) return;
  try {
    const output = { schema: 1, events: (record.events ?? []).map(timing),
      files: (record.files ?? []).filter(item => relativeFile(item.file) && nonnegative(item.durationMs)
        && typeof item.success === "boolean").map(({ file, durationMs, success }) => ({ file, durationMs, success })) };
    if (typeof record.receiptDecision?.reused === "boolean" && reasons.has(record.receiptDecision.reason)) {
      output.receiptDecision = { reused: record.receiptDecision.reused, reason: record.receiptDecision.reason };
    }
    if (sha256(record.inputDigest)) output.inputDigest = record.inputDigest;
    if (record.resultCounts) {
      output.resultCounts = {};
      for (const key of ["selected", "completed", "passed", "failed"]) {
        if (integer(record.resultCounts[key])) output.resultCounts[key] = record.resultCounts[key];
      }
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
  } catch { /* Optional diagnostics cannot change gate success or failure. */ }
}
