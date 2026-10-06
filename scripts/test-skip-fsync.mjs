// Preloaded (NODE_OPTIONS --import) into a local macOS test run, never into CI:
// every fsync and fdatasync in the process returns at once and flushes nothing.
//
// Node on macOS flushes with F_FULLFSYNC, which empties the drive's own cache:
// 4.0 ms a call on an M5 Max SSD, where plain fsync() takes 0.1 ms and Linux CI
// 0.4 ms. One run of the suite makes about 59,400 of them, and they queue on the
// one disk: 288 s at six files at a time, 124 s with them skipped, every test
// passing either way (2026-10-06). What a flush protects is a machine crash, and
// no test crashes the machine; CI keeps every flush on Linux, macOS and Windows.
// ACC flushes through FileHandle#sync; the fs functions are covered as well.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";

const callback = (...args) => {
  const done = args.at(-1);
  if (typeof done === "function") process.nextTick(done, null);
};
fs.fsync = callback;
fs.fdatasync = callback;
fs.fsyncSync = () => {};
fs.fdatasyncSync = () => {};

// FileHandle is not exported; its prototype is reached through a handle.
const handle = await fs.promises.open(os.devNull, "r");
const prototype = Object.getPrototypeOf(handle);
prototype.sync = async function sync() {};
prototype.datasync = async function datasync() {};
await handle.close();

syncBuiltinESMExports();
