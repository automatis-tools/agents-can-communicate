import { spawn } from "node:child_process";
import readline from "node:readline";

const STDERR_LIMIT = 16 * 1024;
const REQUIRED_CAPTURE_FIELDS = [
  "client",
  "version",
  "platform",
  "observedAt",
  "capability",
  "result",
  "fixture",
  "idle",
  "busy",
  "reply",
  "duplicate",
  "fallback",
  "limitations",
];

const PASS_BRANCHES = {
  idle: ["offered", "a passing capture requires idle behavior"],
  busy: ["not_interrupted", "a passing capture requires busy behavior"],
  reply: ["routed", "a passing capture requires reply behavior"],
  duplicate: ["same_message_id", "a passing capture requires duplicate behavior"],
  fallback: ["queued", "a passing capture requires fallback behavior"],
};
const STRING_CAPTURE_FIELDS = [
  "client",
  "version",
  "platform",
  "observedAt",
  "capability",
  "fixture",
];

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
      request.reject(new Error(message.error.message ?? "JSON-RPC request failed"));
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

export function validateCapture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture is an object");
  }
  for (const key of REQUIRED_CAPTURE_FIELDS) {
    if (!Object.hasOwn(value, key)) throw new Error(`capture requires ${key}`);
  }
  for (const key of STRING_CAPTURE_FIELDS) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`capture ${key} is a non-empty string`);
    }
  }
  if (!new Set(["pass", "fail"]).has(value.result)) {
    throw new Error("capture result is pass or fail");
  }
  if (!Array.isArray(value.limitations) || value.limitations.length === 0
    || value.limitations.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error("capture limitations is a non-empty array of non-empty strings");
  }
  if (value.result === "pass") {
    for (const [key, [expected, error]] of Object.entries(PASS_BRANCHES)) {
      if (value[key] !== expected) throw new Error(error);
    }
  }
  for (const [key, [observed]] of Object.entries(PASS_BRANCHES)) {
    if (!new Set([observed, "unobserved"]).has(value[key])) {
      throw new Error(`capture ${key} is ${observed} or unobserved`);
    }
  }
  return Object.freeze({ ...value });
}
