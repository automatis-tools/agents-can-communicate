import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "../src/server.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);
const binary = path.join(repoRoot, "bin", "acc-mcp.mjs");

// A minimal client: writes newline-delimited JSON-RPC to stdin, reads
// newline-delimited JSON-RPC from stdout, keeps stderr separate.
export async function withServer(t, run, { env = {}, reuse } = {}) {
  const workspace = reuse?.workspace
    ?? await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcp-ws-")));
  const dataHome = reuse?.dataHome
    ?? await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcp-home-")));
  if (reuse === undefined) {
    t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }),
      rm(dataHome, { recursive: true, force: true })]));
  }

  const child = spawn(process.execPath, [binary], {
    cwd: workspace,
    env: { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome,
      ACC_MCP_PARTICIPANT: "mcp_client", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const lines = [];
  const waiters = [];
  let exited = null;
  const closed = new Promise(resolve => child.once("close", code => {
    exited = code ?? 0;
    resolve(exited);
  }));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    let index = stdout.indexOf("\n");
    while (index !== -1) {
      lines.push(stdout.slice(0, index));
      stdout = stdout.slice(index + 1);
      index = stdout.indexOf("\n");
      waiters.shift()?.();
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });

  const request = async (method, params, id = Math.floor(Math.random() * 1e6)) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    while (lines.length === 0) {
      const answered = new Promise(resolve => waiters.push(resolve));
      const gaveUp = Promise.race([answered, closed.then(() => "closed")]);
      if (await gaveUp === "closed" && lines.length === 0) {
        throw new Error(`server exited before answering ${method}; stderr: ${stderr}`);
      }
    }
    return JSON.parse(lines.shift());
  };

  const meta = { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {} };

  try {
    const attach = participantId => execFileAsync(process.execPath,
      [path.join(repoRoot, "bin", "acc.mjs"), "attach", "--participant", participantId,
        "--harness", "cli", "--cwd", workspace, "--json"],
      { env: { ...process.env, ACC_DATA_HOME: dataHome, GIT_DIR: "", GIT_WORK_TREE: "" } });
    return await run({ request, meta, child, closed, stderr: () => stderr, workspace, attach,
      dataHome });
  } finally {
    child.stdin.end();
    await closed;
  }
}
