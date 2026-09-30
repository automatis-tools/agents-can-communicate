// npm run the way ACC's managed runtime runs it: npm's own npm-cli.js, under the
// node that runs this test. On Windows `npm` is npm.cmd, a batch file execFile
// cannot start without a shell (`spawn npm ENOENT`), and a shell would parse
// every argument again.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { npmCli } from "../../packages/cli/src/managed-runtime/download.mjs";

const run = promisify(execFile);

/** execFile's result for `npm <args>`; `options` are execFile's. */
export async function runNpm(args, options = {}) {
  return run(process.execPath, [await npmCli(options.env ?? process.env), ...args], options);
}
