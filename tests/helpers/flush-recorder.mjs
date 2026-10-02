// Which files a test's writes flush. Imported before the modules under test,
// whose `open` from node:fs/promises then names every handle it returns; every
// flush of such a handle is recorded with that name.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const flushed = [];
const named = new WeakMap();
const open = fs.promises.open;
fs.promises.open = async (file, ...rest) => {
  const handle = await open(file, ...rest);
  named.set(handle, String(file));
  return handle;
};
syncBuiltinESMExports();

const probe = await open(process.execPath, "r");
const prototype = Object.getPrototypeOf(probe);
await probe.close();
for (const method of ["sync", "datasync"]) {
  const flush = prototype[method];
  prototype[method] = function recorded(...args) {
    flushed.push(named.get(this) ?? "(unnamed)");
    return flush.apply(this, args);
  };
}

/** The paths flushed while `block` ran, in order. */
export async function flushesDuring(block) {
  const from = flushed.length;
  await block();
  return flushed.slice(from);
}
