// Measurement only (throwaway branch), loaded with --import into every node
// process of a test run. Per process: when it started and how long it lived
// (wall clock from process start), its CPU time and every file flush; for an
// acc-hook process also every child it spawned, its event-loop delay, its phase
// marks and its fail-open line.
import dc from "node:diagnostics_channel";
import fs from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

const log = process.env.TMP_HOOKCOST_LOG;
const isHook = /acc-hook\.mjs$/.test(process.argv[1] ?? "");
const isTestFile = /\.test\.mjs$/.test(process.argv.at(-1) ?? "");
const SLOW_FLUSH_MS = 100;
if (log) {
  const boot = Math.round(performance.now());
  const sync = { n: 0, total: 0, max: 0, slow: [] };
  const probe = await fs.promises.open(process.execPath, "r");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  for (const name of ["sync", "datasync"]) {
    const original = proto[name];
    proto[name] = async function (...args) {
      const at = performance.now();
      try { return await original.apply(this, args); } finally {
        const ms = performance.now() - at;
        sync.n += 1; sync.total += ms; sync.max = Math.max(sync.max, ms);
        if (ms >= SLOW_FLUSH_MS) sync.slow.push([Math.round(at), Math.round(ms)]);
      }
    };
  }
  const children = [];
  let delay = null;
  let err = "";
  if (isHook) {
    dc.subscribe("child_process", ({ process: child }) => {
      const entry = { at: Math.round(performance.now()), cmd: "", ms: null };
      children.push(entry);
      const done = () => { entry.ms ??= Math.round(performance.now() - entry.at); };
      child.once("spawn", () => {
        entry.cmd = (child.spawnargs ?? [child.spawnfile]).slice(0, 3).join(" ").slice(0, 120);
      });
      child.once("exit", done);
      child.once("error", error => { entry.cmd ||= String(error.code); done(); });
    });
    delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { err += String(chunk); return write(chunk, ...rest); };
  }
  process.on("exit", () => {
    const wall = Math.round(performance.now());
    if (!isHook && !isTestFile && sync.n === 0 && wall < 2000) return;
    const usage = process.resourceUsage();
    const marks = globalThis.__accPhaseTimes ?? [];
    const phases = marks.map(([phase, at], index) => [phase, Math.round(at),
      Math.round((marks[index + 1]?.[1] ?? performance.now()) - at)]);
    const record = {
      kind: isHook ? "hook" : isTestFile ? "file" : "proc",
      what: isHook ? process.argv[2] : isTestFile ? process.argv.at(-1)
        : process.argv.slice(1, 3).map(arg => arg.split(/[\\/]/).at(-1)).join(" "),
      pid: process.pid, ppid: process.ppid, start: Math.round(performance.timeOrigin), boot, wall,
      cpu: Math.round((usage.userCPUTime + usage.systemCPUTime) / 1000),
      fsync: { n: sync.n, total: Math.round(sync.total), max: Math.round(sync.max),
        slow: sync.slow.slice(0, 20) },
    };
    if (isHook) {
      delay.disable();
      Object.assign(record, { phases, children,
        loopDelay: { max: Math.round(delay.max / 1e6), p99: Math.round(delay.percentile(99) / 1e6) },
        err: err.slice(0, 300) });
    }
    try { fs.appendFileSync(log, `${JSON.stringify(record)}\n`); } catch {}
  });
}
