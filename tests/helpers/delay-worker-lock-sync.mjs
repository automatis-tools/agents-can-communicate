// Preload only in an isolated installed CLI. Its second lock is the update worker.
import { open, writeFile } from "node:fs/promises";
const probe = process.env.ACC_TEST_HANDLE_FILE;
const handle = await open(probe, "w");
const prototype = Object.getPrototypeOf(handle);
await handle.close();
const originalWrite = prototype.writeFile;
const originalSync = prototype.sync;
let owners = 0;
const delayed = new Set();
prototype.writeFile = async function (data, ...args) {
  if (typeof data === "string") {
    let value;
    try { value = JSON.parse(data); } catch { /* Other writes are not lock owners. */ }
    if (value?.pid && value.token && value.acquiredAt && ++owners === 2) delayed.add(this);
  }
  return originalWrite.call(this, data, ...args);
};
prototype.sync = async function (...args) {
  if (delayed.delete(this)) {
    await new Promise(resolve => setTimeout(resolve, 250));
    await writeFile(probe, "worker candidate sync delayed by 250ms\n");
  }
  return originalSync.apply(this, args);
};
