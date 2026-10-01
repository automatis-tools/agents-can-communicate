// Measurement only (throwaway branch): runs beside the suite and, twice a
// second, asks the machine two questions - how late a timer fires (is a process
// getting the CPU) and how long a 4 KB write and flush takes (is the disk
// answering) - with the whole machine's CPU use since the last sample.
// Usage: node scripts/tmp_canary.mjs <log> ; stops when <log>.stop exists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const log = process.argv[2] ?? "canary.log";
const stop = `${log}.stop`;
const target = path.join(os.tmpdir(), `tmp-canary-${process.pid}.bin`);
const block = Buffer.alloc(4096, 1);
const INTERVAL_MS = 500;

const busy = () => os.cpus().reduce((sum, cpu) => {
  const { user, nice, sys, irq, idle } = cpu.times;
  return { used: sum.used + user + nice + sys + irq, all: sum.all + user + nice + sys + irq + idle };
}, { used: 0, all: 0 });

let last = busy();
let due = Date.now() + INTERVAL_MS;
const tick = () => {
  const late = Date.now() - due;
  const at = performance.now();
  const fd = fs.openSync(target, "w");
  try { fs.writeSync(fd, block); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const flush = Math.round(performance.now() - at);
  const now = busy();
  const cpu = Math.round(100 * (now.used - last.used) / Math.max(1, now.all - last.all));
  last = now;
  fs.appendFileSync(log, `${JSON.stringify({ t: Date.now(), late, flush, cpu })}\n`);
  if (fs.existsSync(stop)) { fs.rmSync(target, { force: true }); return; }
  due = Date.now() + INTERVAL_MS;
  setTimeout(tick, INTERVAL_MS);
};
setTimeout(tick, INTERVAL_MS);
