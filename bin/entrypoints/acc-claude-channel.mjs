#!/usr/bin/env node
// Kept only for installs made by ACC 0.7.x or earlier, which wired a Claude Channel MCP
// server. A 0.7.x updater refuses a downloaded package without this file, and a
// plugin copy written by 0.7.x can still ask Claude Code to spawn it until
// `acc install` or `acc update` lays the plugin out again.
//
// A child that answers nothing is reported to the user as a server that failed
// to connect, so this finishes the MCP handshake, declares no Channel and
// offers no tools, and exits when Claude closes its stdin or stops it with a signal.

function answer(message) {
  if (message.method === "initialize") {
    return { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "agents-can-communicate", version: "0.2.0" } };
  }
  if (message.method === "tools/list") return { tools: [] };
  if (message.method === "ping") return {};
  return undefined;
}

function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch {
    return { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } };
  }
  if (message.id === undefined || message.id === null) return null;
  const result = answer(message);
  return result === undefined
    ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } }
    : { jsonrpc: "2.0", id: message.id, result };
}

export async function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const reply = line === "" ? null : handle(line);
      if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
  await new Promise(resolve => {
    process.stdin.once("end", resolve);
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
    process.stdin.resume();
  });
  // A signal can arrive while Claude still holds the pipe open; a stdin left
  // reading would keep this process alive after main() returns.
  process.stdin.destroy();
}
