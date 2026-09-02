import { spawn } from "node:child_process";
import readline from "node:readline";

// The capture contract moved to its own module; older spike callers still
// import the validator from here until Task 3 rewrites them.
export { validateCapture } from "./delivery-capture.mjs";

const STDERR_LIMIT = 16 * 1024;

export function openJsonRpcPeer({ command, args = [], env, timeoutMs }) {
  const child = spawn(command, args, {
    env: env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const notifications = [];
  const pending = new Map();
  let nextId = 1;
  let stderr = Buffer.alloc(0);
  let closed = false;

  child.stderr.on("data", (chunk) => {
    if (stderr.length === STDERR_LIMIT) return;
    const room = STDERR_LIMIT - stderr.length;
    stderr = Buffer.concat([stderr, Buffer.from(chunk).subarray(0, room)]);
  });

  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rejectAll(new Error("JSON-RPC peer wrote invalid JSON"));
      return;
    }

    if (!Object.hasOwn(message, "id")) {
      notifications.push(message);
      return;
    }

    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(Object.assign(new Error(message.error.message ?? "JSON-RPC request failed"),
        { code: message.error.code ?? null }));
    } else {
      request.resolve(message.result);
    }
  });

  child.once("error", (error) => rejectAll(error));
  child.once("exit", (code, signal) => {
    closed = true;
    if (pending.size === 0) return;
    const detail = stderr.length > 0 ? `: ${stderr.toString("utf8")}` : "";
    rejectAll(new Error(`JSON-RPC peer exited (${signal ?? code})${detail}`));
  });

  function rejectAll(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function write(message) {
    if (closed || child.stdin.destroyed) throw new Error("JSON-RPC peer is closed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function notify(method, params) {
    write({ method, params });
  }

  async function close() {
    if (closed) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }

  return { request, notify, notifications, close };
}
