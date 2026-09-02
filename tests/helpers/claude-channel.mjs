import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync }
  from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const channelScript = fileURLToPath(
  new URL("../../scripts/spikes/claude-channel.mjs", import.meta.url));
export const captureClientScript = fileURLToPath(
  new URL("../../scripts/spikes/claude-channel-capture-client.mjs", import.meta.url));

export function trustedTempDir() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acc-channel-test-"));
  chmodSync(tempDir, 0o700);
  return realpathSync(tempDir);
}

/**
 * Spawn the disposable Channel the way Claude Code would - as a stdio MCP child -
 * and act as the Claude side of that stdio. The capture directory stands in for
 * the session-scoped directory a real capture uses.
 */
export async function startChannel({ captureDir = trustedTempDir(), env = {},
  waitForReady = waitForRegistration, onSpawn } = {}) {
  const child = spawn(process.execPath, [channelScript], {
    env: { ...process.env, ACC_CHANNEL_CAPTURE_DIR: captureDir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => child.once("exit",
    (code, signal) => resolve({ code, signal })));
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  let nextId = 1;
  let stderr = "";
  let closing;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  lines.on("line", line => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });

  const cleanup = ({ kill = false }) => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      if (kill && child.exitCode === null) child.kill("SIGTERM");
      else if (child.exitCode === null) child.stdin.end();
      const result = await exited;
      lines.close();
      return { ...result, stderr };
    })();
    return closing;
  };
  const nextMessage = () => messages.length > 0
    ? Promise.resolve(messages.shift())
    : new Promise(resolve => waiters.push(resolve));
  const nextMessageOrNull = timeoutMs => new Promise(resolve => {
    if (messages.length > 0) { resolve(messages.shift()); return; }
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      resolve(null);
    }, timeoutMs);
    const waiter = message => { clearTimeout(timer); resolve(message); };
    waiters.push(waiter);
  });
  const channel = {
    child, exited, captureDir, nextMessage, nextMessageOrNull,
    get stderr() { return stderr; },
    socketPath: path.join(captureDir, "endpoint.sock"),
    observationPath: path.join(captureDir, "observations.jsonl"),
    registrationPath: path.join(captureDir, "endpoint.json"),
    registration: null,
    async request(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      while (true) {
        const message = await nextMessage();
        if (message.id === id) {
          if (message.error) throw new Error(message.error.message);
          return message.result;
        }
        messages.push(message);
      }
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    observations() {
      if (!existsSync(channel.observationPath)) return [];
      return readFileSync(channel.observationPath, "utf8").split("\n")
        .filter(Boolean).map(line => JSON.parse(line));
    },
    async initialize() {
      const result = await channel.request("initialize", { protocolVersion: "2025-11-25" });
      channel.notify("notifications/initialized", {});
      return result;
    },
    close: () => cleanup({}),
    kill: () => cleanup({ kill: true }),
    remove: () => rmSync(captureDir, { recursive: true, force: true }),
  };
  onSpawn?.(channel);
  try {
    channel.registration = await waitForReady(channel);
    return channel;
  } catch (error) {
    await cleanup({ kill: true });
    rmSync(captureDir, { recursive: true, force: true });
    throw error;
  }
}

export async function runCaptureClient({ socketPath, nonce, messageId, kind = "question",
  subject = "capture subject", body = "capture body", inReplyTo, extraArgs = [] }) {
  const args = [captureClientScript, "--socket", socketPath, "--nonce", nonce,
    "--message-id", messageId, "--kind", kind, "--subject", subject, "--body", body,
    ...(inReplyTo === undefined ? [] : ["--in-reply-to", inReplyTo]), ...extraArgs];
  return runProcess(args);
}

export function runProcess(args, { timeoutMs = 4_000, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", code => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(stdout); } catch { /* not JSON: caller inspects stdout */ }
      resolve({ code, stdout, stderr, result });
    });
  });
}

export async function runRejectedChannel(env) {
  const child = spawn(process.execPath, [channelScript], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.once("exit", code => resolve({ code, stderr })));
  const timedOut = await Promise.race([
    exit,
    new Promise(resolve => setTimeout(() => resolve(null), 500)),
  ]);
  if (timedOut) return timedOut;
  child.kill("SIGTERM");
  return exit;
}

async function waitForRegistration(channel) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const registration = JSON.parse(readFileSync(channel.registrationPath, "utf8"));
      statSync(channel.socketPath);
      return registration;
    } catch {
      if (channel.child.exitCode !== null) {
        throw new Error(`channel exited: ${channel.stderr}`);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error(`channel endpoint was not registered: ${channel.stderr}`);
}

export async function connectSocket(socketPath, { attempts = 100, delayMs = 5 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        const onError = error => reject(error);
        socket.once("error", onError);
        socket.once("connect", () => {
          socket.off("error", onError);
          resolve(socket);
        });
      });
    } catch (error) {
      if (!["ECONNREFUSED", "ENOENT"].includes(error.code) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

export function nextSocketMessage(socket, { timeoutMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: socket });
    const finish = () => {
      clearTimeout(timer);
      lines.close();
      socket.off("error", onError);
    };
    const onError = error => { finish(); reject(error); };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("socket reply timed out"));
    }, timeoutMs);
    lines.once("line", line => {
      finish();
      resolve(JSON.parse(line));
    });
    socket.once("error", onError);
  });
}

export function sendEnvelope(socket, envelope) {
  socket.write(`${JSON.stringify(envelope)}\n`);
}

export const pathExists = existsSync;
