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
  binary: selectedBinary = binary, requestTimeoutMs = 15_000, closeTimeoutMs = 5_000 }) {
  const child = spawn(process.execPath, [selectedBinary], {
    cwd,
    env: { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome,
      ACC_MCP_PARTICIPANT: participant, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffered = "";
  let stderr = "";
  let failure = null;
  let nextId = 0;
  const pending = new Map();
  const rejectPending = error => {
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
  };
  const closed = new Promise(resolve => child.once("close", code => {
    rejectPending(new Error(`server exited before answering a request; stderr: ${stderr}`));
    resolve(code ?? 0);
  }));
  child.on("error", error => rejectPending(error));
  child.stdin.on("error", error => rejectPending(error));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      let response;
      try { response = JSON.parse(line); }
      catch {
        rejectPending(new Error(`server emitted invalid JSON; stderr: ${stderr}`));
        continue;
      }
      if (response !== null && typeof response === "object") {
        pending.get(response.id)?.resolve(response);
      }
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });

  const request = (method, params, id) => new Promise((resolve, reject) => {
    if (id === undefined) {
      do { id = ++nextId; } while (pending.has(id));
    }
    if (failure !== null) return reject(failure);
    if (pending.has(id)) return reject(new Error(`duplicate pending request id ${id}`));
    const finish = (settle, value) => {
      clearTimeout(timer);
      pending.delete(id);
      settle(value);
    };
    const timer = setTimeout(() => finish(reject,
      new Error(`server timed out answering ${method}; stderr: ${stderr}`)), requestTimeoutMs);
    pending.set(id, { resolve: value => finish(resolve, value),
      reject: error => finish(reject, new Error(`${error.message}; request: ${method}`)) });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
      if (error) pending.get(id)?.reject(error);
    });
  });

  return { request, child, closed, stderr: () => stderr,
    close: async () => {
      child.stdin.end();
      let timer;
      try {
        return await Promise.race([closed, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`server timed out closing; stderr: ${stderr}`)),
            closeTimeoutMs);
        })]);
      } catch (error) {
        child.kill("SIGKILL");
        // close waits for every inherited pipe, including pipes held by a
        // descendant. Release only our ends and bound the post-kill wait too.
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
        await Promise.race([closed, new Promise(resolve => {
          timer = setTimeout(resolve, closeTimeoutMs);
        })]);
        throw error;
      } finally { clearTimeout(timer); }
    } };
}
