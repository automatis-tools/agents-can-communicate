import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

const run = promisify(execFile);
const server = path.join(path.resolve(import.meta.dirname, "..", ".."), "bin", "acc-mcp.mjs");

/**
 * The server reads nothing from the command line, so nothing may be passed on it.
 *
 * It used to accept and ignore anything. `acc-mcp --cwd <project>` - the habit
 * `acc` teaches - started a server rooted wherever the client happened to launch
 * it: `acc_sync` answered `solo` from a workspace nobody else was in, and
 * nothing anywhere said why. Found by configuring one and wondering where
 * everybody had gone.
 */
const start = (argv, env = {}) => {
  const child = run(process.execPath, [server, ...argv], { env: { ...process.env, ...env } });
  // Closed at once: the server reads stdio JSON-RPC and runs until its input
  // ends, so a test that leaves it open waits for a conversation nobody is
  // having.
  child.child.stdin.end();
  return child.then(result => ({ code: 0, ...result }), error => error);
};

test("an argument is refused, and the refusal says what to use instead", async () => {
  const refused = await start(["--cwd", "/tmp"]);

  assert.equal(refused.code, EXIT.USAGE);
  assert.match(refused.stderr, /takes no arguments/);
  assert.match(refused.stderr, /ACC_MCP_PARTICIPANT/);
  assert.match(refused.stderr, /ACC_MCP_WORKSPACE/);
  // Named, so the reader sees which of their arguments was the problem.
  assert.match(refused.stderr, /--cwd \/tmp/);
});

test("with no arguments it serves, and stops when the input ends", async t => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  // Two directories, because ACC refuses a data home inside the workspace - as
  // it should, and as it told me when this test first put them in one place.
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcp-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcp-data-")));
  t.after(() => Promise.all([project, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  const served = await start([], { ACC_MCP_WORKSPACE: project, ACC_DATA_HOME: dataHome });

  assert.equal(served.code, 0, served.stderr);
});
