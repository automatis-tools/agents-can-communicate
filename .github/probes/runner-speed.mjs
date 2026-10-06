// What this runner is and how fast it does what the suite does most: start a
// node process, start the CLI, flush a small file. Runs on hosted runners vary
// by about half; this lets two runs be compared on equal terms.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, openSync, writeSync, fsyncSync, closeSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..", "..");
const out = process.argv[2];
const time = fn => { const start = performance.now(); fn(); return performance.now() - start; };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const p95 = values => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];

const cpu = time(() => { let h = Buffer.alloc(32); for (let i = 0; i < 400_000; i += 1) h = createHash("sha256").update(h).digest(); });
const bare = Array.from({ length: 20 }, () => time(() => execFileSync(process.execPath, ["-e", "0"])));
const dataHome = mkdtempSync(path.join(os.tmpdir(), "acc-speed-"));
const env = { ...process.env, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1" };
const acc = Array.from({ length: 12 }, () => time(() => execFileSync(process.execPath,
  [path.join(repo, "bin", "acc.mjs"), "version", "--json"], { env })));
const cache = path.join(dataHome, "compile-cache");
const accCached = Array.from({ length: 12 }, () => time(() => execFileSync(process.execPath,
  [path.join(repo, "bin", "acc.mjs"), "version", "--json"], { env: { ...env, NODE_COMPILE_CACHE: cache } })));
const flush = Array.from({ length: 150 }, (_, index) => {
  const file = path.join(dataHome, `flush-${index}`);
  return time(() => { const fd = openSync(file, "w"); writeSync(fd, Buffer.alloc(4096, 1)); fsyncSync(fd); closeSync(fd); });
});
rmSync(dataHome, { recursive: true, force: true });

const result = {
  platform: process.platform, cpus: os.availableParallelism(), model: os.cpus()[0]?.model,
  memoryGb: Math.round(os.totalmem() / 2 ** 30), tmp: os.tmpdir(),
  cpuMs: Math.round(cpu), bareNodeMs: Math.round(median(bare)),
  accVersionMs: Math.round(median(acc.slice(1))), accVersionCachedMs: Math.round(median(accCached.slice(1))),
  flushMedianMs: +median(flush).toFixed(2), flushP95Ms: +p95(flush).toFixed(2),
};
console.log(JSON.stringify(result));
if (out) writeFileSync(out, `${JSON.stringify(result)}\n`);
