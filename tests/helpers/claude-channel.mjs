import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const channelScript = fileURLToPath(
  new URL("../../scripts/spikes/claude-channel.mjs", import.meta.url));

export function trustedTempDir() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acc-channel-test-"));
  chmodSync(tempDir, 0o700);
  return tempDir;
}

export async function startChannel({ waitForReady = waitForSocket, onSpawn } = {}) {
  const tempDir = trustedTempDir();
  const socketPath = path.join(tempDir, "channel.sock");
  const child = spawn(process.execPath, [channelScript], {
    env: { ...process.env, ACC_CHANNEL_SPIKE_SOCKET: socketPath },
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

  const cleanup = ({ expectZero, kill = false }) => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      if (kill && child.exitCode === null) child.kill("SIGTERM");
      else if (child.exitCode === null) child.stdin.end();
      const result = await exited;
      lines.close();
      rmSync(tempDir, { recursive: true, force: true });
      if (expectZero) assert.equal(result.code, 0, stderr);
      return result;
    })();
    return closing;
  };
  const nextMessage = () => messages.length > 0
    ? Promise.resolve(messages.shift())
    : new Promise(resolve => waiters.push(resolve));
  const channel = {
    child, exited, socketPath, tempDir, nextMessage,
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
    close: () => cleanup({ expectZero: true }),
  };
  onSpawn?.(channel);
  try {
    await waitForReady(socketPath, child, () => stderr);
    return channel;
  } catch (error) {
    await cleanup({ expectZero: false, kill: true });
    throw error;
  }
}

export async function startConnectedChannel({ connectPath = channel => channel.socketPath,
  connectOptions, onChannel } = {}) {
  const channel = await startChannel();
  onChannel?.(channel);
  try {
    const socket = await connectSocket(connectPath(channel), connectOptions);
    return { ...channel, socket, async close() {
      socket.end();
      await channel.close();
    } };
  } catch (error) {
    await channel.close();
    throw error;
  }
}

export async function runRejectedChannel(socketPath) {
  const child = spawn(process.execPath, [channelScript], {
    env: { ...process.env, ACC_CHANNEL_SPIKE_SOCKET: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.once("exit", code => resolve({ code, stderr })));
  const timedOut = await Promise.race([
    exit,
    new Promise(resolve => setTimeout(() => resolve(null), 200)),
  ]);
  if (timedOut) return timedOut;
  child.kill("SIGTERM");
  return exit;
}

async function waitForSocket(socketPath, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      statSync(socketPath);
      return;
    } catch {
      if (child.exitCode !== null) throw new Error(`channel exited: ${stderr()}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error(`channel socket was not created: ${stderr()}`);
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

export function nextSocketMessage(socket) {
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
    }, 200);
    lines.once("line", line => {
      finish();
      resolve(JSON.parse(line));
    });
    socket.once("error", onError);
  });
}

export const pathExists = existsSync;
