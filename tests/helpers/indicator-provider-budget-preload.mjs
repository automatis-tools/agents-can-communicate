import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const execFile = childProcess.execFile;
const observed = [];
function fixtureOptions(file, args, options) {
  observed.push({ file, reader: args?.[0], options: { ...options } });
  return file === process.execPath && args?.[0] === process.argv[2]
    ? { ...options, timeout: 2000 } : options;
}
function fixtureExecFile(file, args, options, callback) {
  return execFile(file, args, fixtureOptions(file, args, options), callback);
}
// Keep Node's native { stdout, stderr } promise result and its child handle.
fixtureExecFile[promisify.custom] = (file, args, options) =>
  execFile[promisify.custom](file, args, fixtureOptions(file, args, options));
childProcess.execFile = fixtureExecFile;
syncBuiltinESMExports();

// The provider catches reader errors; validate outside that catch so a changed
// production budget cannot silently pass as an expected problem report.
process.once("beforeExit", () => {
  assert.deepEqual(observed, [{ file: process.execPath, reader: process.argv[2],
    options: { timeout: 400, maxBuffer: 8192 } }], "production reader budget changed");
});
