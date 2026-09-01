#!/usr/bin/env node
// Hook entry point: `acc-hook <adapter-id> <kind>`, payload on stdin.
//
// Every harness runs this as a short-lived child process in front of the user's
// turn. The one rule that overrides all others here: never be the reason
// someone's session stops working. Unknown adapter, malformed payload, broken
// store, missing binding - all of them end in "allow, exit 0".
import { randomBytes } from "node:crypto";

import { createId } from "@agents-can-communicate/protocol";
import { runHook } from "@agents-can-communicate/hook-runner";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

const adapters = {
  claude_code: createClaudeCodeAdapter(),
  codex: createCodexAdapter(),
  gemini_cli: createGeminiCliAdapter(),
  grok: createGrokAdapter(),
  kimi: createKimiAdapter(),
};

const readStdin = () => new Promise(resolve => {
  // A hook is always given its payload on stdin, but a client that closes it
  // without writing must not leave this process hanging in front of a turn.
  if (process.stdin.isTTY) return resolve("");
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => resolve(raw));
  process.stdin.on("error", () => resolve(""));
  return undefined;
});

const [adapterId] = process.argv.slice(2);

let payload = null;
try {
  payload = JSON.parse(await readStdin());
} catch {
  payload = null;
}

const result = await runHook({ adapterId, payload, adapters,
  runtime: { clock: { now: () => new Date().toISOString() },
    ids: { next: kind => createId(kind, randomBytes) } },
  env: process.env });

if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(`${result.stderr}\n`);
process.exitCode = result.exitCode ?? 0;
