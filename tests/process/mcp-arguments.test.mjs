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

/**
 * A directory that cannot be a workspace still gets the catalogue (#149).
 *
 * MCP directories and some hosts start a server from the home directory and
 * only call `tools/list`. Home holds ACC's own state, so the server used to end
 * there before `initialize`, with a stack trace on stderr.
 */
test("outside a workspace it lists its tools, and a tool call says why it cannot run", async t => {
  const { spawn } = await import("node:child_process");
  const { mkdir, mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcp-home-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, "acc-data");
  await mkdir(dataHome);
  const child = spawn(process.execPath, [server], { cwd: home, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, ACC_DATA_HOME: dataHome, ACC_MCP_WORKSPACE: home } });
  const answers = new Map();
  let buffered = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
      const message = JSON.parse(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      answers.get(message.id)?.(message);
    }
  });
  // A server that ends before answering fails the call instead of leaving it waiting.
  const closed = new Promise(resolve => child.on("close", resolve));
  const ask = (id, method, params) => new Promise((resolve, reject) => {
    answers.set(id, resolve);
    closed.then(code => reject(new Error(`acc-mcp exited with ${code} before answering `
      + `${method}:\n${stderr}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const initialized = await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "catalogue", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await ask(2, "tools/list", {});
  const called = await ask(3, "tools/call", { name: "acc_status", arguments: {} });
  const read = await ask(4, "resources/read", { uri: "acc://inbox" });
  child.stdin.end();
  const code = await closed;

  assert.equal(initialized.result.serverInfo.name, "agents-can-communicate");
  assert.ok(listed.result.tools.some(tool => tool.name === "acc_status"), JSON.stringify(listed));
  assert.equal(called.result.isError, true);
  assert.match(called.result.content[0].text, /^acc_status: no workspace: .*holds ACC's own state/);
  assert.match(read.error.message, /^no workspace: /);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /\n\s+at /, "a stack trace reached stderr");
});
