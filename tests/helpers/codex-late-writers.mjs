// Waits for processes that `codex exec` left writing into its home.
//
// Codex syncs its curated plugin list on startup: it runs `git fetch` and then
// `git reset --hard` in `CODEX_HOME/.tmp/plugins-clone-*`. A stub-model run can
// exit before that finishes, and the git child then keeps writing after `exec`
// returns. Removing the client home at that moment failed on the Linux
// real-clients job with ENOTEMPTY on `.codex/.tmp/plugins-clone-*/plugins`
// (Codex 0.165.0, PR #456), although every assertion had passed.
//
// The fixture lets those writers finish rather than retrying the removal: a
// POSIX removal failure stays a visible race (see fixture-cleanup.mjs). A writer
// still running at the deadline fails the test with its command line.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function processesUnder(directory) {
  const { stdout } = await run("ps", ["-ww", "-axo", "pid=,args="], { maxBuffer: 16 << 20 });
  return stdout.split("\n").map(line => line.trim())
    .filter(line => line.includes(directory) && !line.startsWith(`${process.pid} `));
}

/** POSIX only: the Codex tests that call this are skipped on Windows. */
export async function waitForCodexWriters(codexHome, { timeoutMs = 60_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const writers = await processesUnder(codexHome);
    if (writers.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`processes still write under ${codexHome} after ${timeoutMs} ms:\n`
        + writers.join("\n"));
    }
    await pause(pollMs);
  }
}
