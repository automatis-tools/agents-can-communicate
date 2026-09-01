#!/usr/bin/env node
// Hook entry point: `acc-hook <adapter-id> <kind>`, payload on stdin.
//
// Every harness runs this as a short-lived child process in front of the user's
// turn. The one rule that overrides all others here: never be the reason
// someone's session stops working. Unknown adapter, malformed payload, broken
// store, missing binding - all of them end in "allow, exit 0".
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

export const writeOutput = (stream, output, { deadlineAt } = {}) => {
  if (output === "") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error === undefined || error === null) resolve();
      else reject(error);
    };
    if (deadlineAt !== undefined) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        finish(new Error("hook budget exhausted before stdout write"));
        return;
      }
      timer = setTimeout(() => finish(
        new Error("hook budget exhausted waiting for stdout callback")), remaining);
    }
    try {
      stream.write(output, finish);
    } catch (error) {
      finish(error);
    }
  });
};

const DIAGNOSTIC_BYTES = 512;

function boundedDiagnostic(label, error) {
  const detail = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/g, " ");
  let line = `acc: ${label}: ${detail}`;
  while (Buffer.byteLength(`${line}\n`, "utf8") > DIAGNOSTIC_BYTES && line.length > 0) {
    line = line.slice(0, -1);
  }
  return `${line}\n`;
}

function tryWrite(stream, output) {
  if (output === "") return;
  try {
    stream.write(output, () => {});
  } catch {
    // A broken diagnostic stream must not turn a failed-open hook into a crash.
  }
}

export async function completeHookOutput(result,
  { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    await writeOutput(stdout, result.stdout ?? "", { deadlineAt: result.deadlineAt });
  } catch (error) {
    tryWrite(stderr, boundedDiagnostic("stdout write failed", error));
    return { exitCode: 0, wroteStdout: false, committedOffers: false };
  }

  let committedOffers = true;
  try {
    await result.commitOffers?.();
  } catch (error) {
    committedOffers = false;
    tryWrite(stderr, boundedDiagnostic("offer commit failed", error));
  }
  if (result.stderr) tryWrite(stderr, `${result.stderr}\n`);
  return { exitCode: 0, wroteStdout: true, committedOffers };
}

async function main() {
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

  const completed = await completeHookOutput(result);
  process.exitCode = result.exitCode ?? completed.exitCode;
}

let isMain = false;
try {
  isMain = process.argv[1] !== undefined
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}

if (isMain) await main();
