import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const binary = path.join(repoRoot, "bin", "acc-mcp.mjs");

export const PROTOCOL_META = protocolVersion => ({
  "io.modelcontextprotocol/protocolVersion": protocolVersion,
  "io.modelcontextprotocol/clientCapabilities": {},
});

/**
 * A minimal newline-delimited JSON-RPC client over stdio.
 *
 * Deliberately not the SDK: the point of an MCP-only run is to show what a
 * generic client gets, so the harness has to be as generic as the claim.
 */
export function connectMcp({ cwd, dataHome, participant = "mcp_client", env = {},
  binary: selectedBinary = binary }) {
  const child = spawn(process.execPath, [selectedBinary], {
    cwd,
    env: { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome,
      ACC_MCP_PARTICIPANT: participant, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffered = "";
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
    buffered += chunk;
    let index = buffered.indexOf("\n");
    while (index !== -1) {
      lines.push(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf("\n");
      waiters.shift()?.();
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });

  const request = async (method, params, id = Math.floor(Math.random() * 1e6)) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    while (lines.length === 0) {
      const answered = new Promise(resolve => waiters.push(resolve));
      // Waiting on a reply that will never come is a hang, not a failure, so the
      // server's exit races the answer.
      if (await Promise.race([answered, closed.then(() => "closed")]) === "closed"
        && lines.length === 0) {
        throw new Error(`server exited before answering ${method}; stderr: ${stderr}`);
      }
    }
    return JSON.parse(lines.shift());
  };

  return { request, child, closed, stderr: () => stderr,
    close: async () => { child.stdin.end(); return closed; } };
}
