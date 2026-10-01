// Measurement only (throwaway branch), loaded with --import into every node
// process of a test run: per process, its run time and every file flush it
// made; for an acc-hook process also its phase marks and its fail-open line.
import fs from "node:fs";

const log = process.env.TMP_HOOKCOST_LOG;
const isHook = /acc-hook\.mjs$/.test(process.argv[1] ?? "");
if (log) {
  const started = performance.now();
  const sync = { n: 0, total: 0, max: 0 };
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
      }
    };
  }
  let err = "";
  if (isHook) {
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { err += String(chunk); return write(chunk, ...rest); };
  }
  process.on("exit", () => {
    if (!isHook && sync.n === 0) return;
    const marks = globalThis.__accPhaseTimes ?? [];
    const phases = marks.map(([phase, at], index) => [phase,
      Math.round((marks[index + 1]?.[1] ?? performance.now()) - at)]);
    try {
      fs.appendFileSync(log, `${JSON.stringify({ kind: isHook ? "hook" : "test",
        what: isHook ? process.argv[2] : process.argv.at(-1), ms: Math.round(performance.now() - started),
        fsync: { n: sync.n, total: Math.round(sync.total), max: Math.round(sync.max) },
        ...(isHook ? { phases, err: err.slice(0, 200) } : {}) })}\n`);
    } catch {}
  });
}
