#!/usr/bin/env node
// Hook entry point: `acc-hook <adapter-id> <kind>`, payload on stdin.
//
// Every harness runs this as a short-lived child process in front of the user's
// turn. The one rule that overrides all others here: never be the reason
// someone's session stops working. Unknown adapter, malformed payload, broken
// store, missing binding - all of them end in "allow, exit 0".
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createId } from "@agents-can-communicate/protocol";
import { runHook } from "@agents-can-communicate/hook-runner";
import { resolvePinnedEntrypoint } from "@agents-can-communicate/cli";

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

import { completeHookOutput } from "./hook-output.mjs";

// A pin is keyed by harness session id, which only an adapter's own
// normalisation can find inside a payload. This runs the same normalisation
// `runHook` will run a moment later - cheap, in-memory, no store touched - so
// a hook that has no pin to look up pays nothing beyond it. Any adapter or
// payload that will not yield a session id simply has no pin to find, same as
// today's no-pin behaviour.
async function harnessSessionIdFor(adapterId, payload) {
  try {
    const event = await adapters[adapterId]?.normalizeHook(payload);
    return typeof event?.sessionId === "string" ? event.sessionId : null;
  } catch {
    return null;
  }
}

// A pinned generation is only ever another build of this same codebase, but
// it can still be broken on disk - deleted mid-write, a corrupt install. This
// tries it and reports failure rather than letting an import error or a
// throwing `main` escape: the caller then runs the turn on the active
// generation instead, exactly as if there had been no pin.
async function delegateToPin({ managerRoot, packageRoot, adapterId, payload }) {
  if (managerRoot === null || packageRoot === null) return false;
  const harnessSessionId = await harnessSessionIdFor(adapterId, payload);
  if (harnessSessionId === null) return false;
  const pinned = await resolvePinnedEntrypoint({ root: managerRoot, harnessSessionId, active: packageRoot });
  if (pinned === null) return false;
  try {
    const runtime = await import(pathToFileURL(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs")).href);
    await runtime.main({ managerRoot, packageRoot: pinned, payload });
    return true;
  } catch {
    return false;
  }
}

export async function main({ managerRoot = null, packageRoot = null, payload } = {}) {
  const [adapterId] = process.argv.slice(2);

  // A delegating caller already read stdin once for the whole process and
  // hands its parsed payload down; only the outermost call reads it here.
  if (payload === undefined) {
    try {
      payload = JSON.parse(await readStdin());
    } catch {
      payload = null;
    }
  }

  if (await delegateToPin({ managerRoot, packageRoot, adapterId, payload })) return;

  const result = await runHook({ adapterId, payload, adapters,
    runtime: { clock: { now: () => new Date().toISOString() },
      ids: { next: kind => createId(kind, randomBytes) } },
    env: process.env });

  const completed = await completeHookOutput(result);
  process.exitCode = result.exitCode ?? completed.exitCode;
}
