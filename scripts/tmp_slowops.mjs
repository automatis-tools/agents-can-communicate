// Measurement only (throwaway branch), loaded with `--import` into every node
// process of a test run: each filesystem call, file-handle call and child
// process that takes longer than TMP_SLOWOPS_MS is appended to TMP_SLOWOPS_LOG
// with its argument and the frames that called it.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const LOG = process.env.TMP_SLOWOPS_LOG;
const LIMIT = Number(process.env.TMP_SLOWOPS_MS ?? 250);
const fd = LOG === undefined ? null : fs.openSync(LOG, "a");
const writeLine = fs.writeSync;
let inside = false;
const frames = () => new Error().stack.split("\n").slice(3, 9).map(line => line.trim()
  .replace(/^at /, "").replace(/file:\/\/\/[^)]*?(packages|bin|tests)[\\/]/, "$1/")).join(" < ");
const record = (ms, op, detail) => {
  if (fd === null || ms < LIMIT || inside) return;
  inside = true;
  try {
    writeLine(fd, `${new Date().toISOString()} pid=${process.pid} ${Math.round(ms)}ms ${op} `
      + `${String(detail).slice(-140)} | ${frames()}\n`);
  } catch {} finally { inside = false; }
};
const timed = (target, name, op, describe) => {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function (...args) {
    const started = performance.now();
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.finally(() => record(performance.now() - started, op, describe(this, args)));
    }
    record(performance.now() - started, op, describe(this, args));
    return result;
  };
};

for (const name of ["open", "rename", "readFile", "writeFile", "mkdir", "mkdtemp", "rmdir", "rm",
  "lstat", "stat", "realpath", "readdir", "unlink", "link", "copyFile", "access", "opendir", "cp"]) {
  timed(fs.promises, name, `fs.${name}`, (_, args) => args[0]);
}
for (const name of ["realpathSync", "lstatSync", "statSync", "openSync", "fsyncSync", "renameSync",
  "readFileSync", "writeFileSync", "mkdirSync", "rmSync", "readdirSync", "existsSync"]) {
  timed(fs, name, `fs.${name}`, (_, args) => args[0]);
}
const probe = await fs.promises.open(process.execPath, "r");
const handlePrototype = Object.getPrototypeOf(probe);
await probe.close();
for (const name of ["sync", "datasync", "close", "read", "write", "readFile", "writeFile", "stat"]) {
  timed(handlePrototype, name, `handle.${name}`, handle => `fd ${handle.fd}`);
}
for (const name of ["spawn", "execFile"]) {
  const original = childProcess[name];
  childProcess[name] = function (file, args, ...rest) {
    const started = performance.now();
    const child = original.call(this, file, args, ...rest);
    const command = `${file} ${Array.isArray(args) ? args.slice(0, 5).join(" ") : ""}`;
    child?.once?.("exit", () => record(performance.now() - started, `child.${name}`, command));
    return child;
  };
}
syncBuiltinESMExports();
