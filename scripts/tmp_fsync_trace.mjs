// Measurement only (throwaway branch), loaded with --import into hook
// processes: every file flush and every rename, with the file, the hook phase
// it fell in, the code that asked for it and how long it took.
import fs from "node:fs";

const log = process.env.TMP_FSYNC_TRACE;
if (log && /acc-hook\.mjs$/.test(process.argv[1] ?? "")) {
  const paths = new WeakMap();
  const phase = () => globalThis.__accPhaseTimes?.at(-1)?.[0] ?? "starting";
  const caller = () => new Error().stack.split("\n").slice(3)
    .filter(line => /packages[\\/]/.test(line)).slice(0, 4)
    .map(line => line.trim().replace(/^at /, "").replace(/\(?file:\/\/\/.*?packages[\\/]/, "")
      .replace(/:\d+\)?$/, "")).join(" < ");
  const events = [];
  const open = fs.promises.open;
  fs.promises.open = async function (file, ...rest) {
    const handle = await open.call(this, file, ...rest);
    paths.set(handle, String(file));
    return handle;
  };
  const probe = await open(process.execPath, "r");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  for (const name of ["sync", "datasync"]) {
    const original = proto[name];
    proto[name] = async function (...args) {
      const at = performance.now();
      try { return await original.apply(this, args); } finally {
        events.push({ op: name, path: paths.get(this) ?? "?", phase: phase(),
          ms: Math.round((performance.now() - at) * 10) / 10, by: caller() });
      }
    };
  }
  const rename = fs.promises.rename;
  fs.promises.rename = async function (from, to) {
    const at = performance.now();
    try { return await rename.call(this, from, to); } finally {
      events.push({ op: "rename", path: String(to), phase: phase(),
        ms: Math.round((performance.now() - at) * 10) / 10, by: caller() });
    }
  };
  (await import("node:module")).syncBuiltinESMExports();
  process.on("exit", () => {
    try {
      fs.appendFileSync(log, `${JSON.stringify({ hook: process.env.TMP_FSYNC_LABEL ?? process.argv[2],
        ms: Math.round(performance.now()), events })}\n`);
    } catch {}
  });
}
