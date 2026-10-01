// Measurement only (throwaway branch): in an acc-hook process, keep what it
// writes to stderr and how long it ran, and append one line at exit.
import fs from "node:fs";

const log = process.env.TMP_HOOKPHASE_LOG;
if (log && /acc-hook\.mjs$/.test(process.argv[1] ?? "")) {
  const started = performance.now();
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { err += String(chunk); return write(chunk, ...rest); };
  process.on("exit", () => {
    try {
      fs.appendFileSync(log, `${JSON.stringify({ ms: Math.round(performance.now() - started),
        adapter: process.argv[2], err: err.slice(0, 300) })}\n`);
    } catch {}
  });
}
