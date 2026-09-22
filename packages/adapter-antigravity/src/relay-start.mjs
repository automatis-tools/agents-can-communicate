import { spawn as nodeSpawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";

import { ENDPOINT_VARIABLES, endpointFrom } from "./agentapi.mjs";
import { isPrintMode } from "./native-delivery.mjs";

/**
 * The command the agent runs once per conversation.
 *
 * It is the only ACC code that sees the session endpoint in an environment it
 * did not create, and its job is to move that endpoint somewhere smaller: into
 * the memory of a detached child started without it. Every refusal is one line
 * and exit 0 - this runs inside the agent's own turn, where an error is
 * something the model has to reason about, not a crash.
 */
export const REFUSALS = Object.freeze({
  noEndpoint: "ACC: this shell has no Antigravity session endpoint; run this from an Antigravity agent.",
  notUnderAgy: "ACC: no Antigravity process was found above this command; nothing was started.",
  printMode: "ACC: this is a print-mode session, which ends with its turn; live delivery is not needed here.",
  policyOff: "ACC: live delivery is off for Antigravity; enable it with acc install --adapter antigravity --delivery actionable.",
  noSession: "ACC: this conversation has no ACC session yet; send it one prompt, then run this again.",
  alreadyRunning: "ACC: live delivery is already running for this conversation.",
});
const FAILED = "ACC: live delivery did not start; peers still reach this conversation at its next turn.";

export function cleanEnv(env) {
  const next = { ...env };
  for (const name of ENDPOINT_VARIABLES) delete next[name];
  return next;
}

/**
 * The workspace whose ACC session this conversation opened - found by the
 * conversation id, in exactly one workspace, and owned by this very agy.
 */
export async function findConversation({ dataHome, conversationId, agyPid,
  load = loadSessionBinding, list = readdir }) {
  const workspaces = path.join(dataHome, "acc", "workspaces");
  let names;
  try { names = await list(workspaces); } catch { return null; }
  const found = [];
  for (const workspaceId of names) {
    const runtimeDir = path.join(workspaces, workspaceId);
    const binding = await load({ runtimeDir, harnessSessionId: conversationId }).catch(() => null);
    if (binding !== null && binding.clientPid === agyPid) found.push({ runtimeDir, workspaceId, binding });
  }
  return found.length === 1 ? found[0] : null;
}

export async function startRelay(ports) {
  try {
    const endpoint = endpointFrom(ports.env);
    if (endpoint === null) return REFUSALS.noEndpoint;
    const agyPid = ports.resolveAgyPid(await ports.readTable(), ports.pid);
    if (!Number.isInteger(agyPid) || agyPid <= 0) return REFUSALS.notUnderAgy;
    if (isPrintMode(await ports.argvOf(agyPid))) return REFUSALS.printMode;
    if (await ports.readPolicy() === "off") return REFUSALS.policyOff;
    const found = await ports.findConversation({ conversationId: endpoint.conversationId, agyPid });
    if (found === null) return REFUSALS.noSession;
    if (await ports.liveRelayFor({ runtimeDir: found.runtimeDir,
      conversationId: endpoint.conversationId })) return REFUSALS.alreadyRunning;
    const started = await ports.spawnRun({ env: cleanEnv(ports.env), payload: { ...endpoint, agyPid,
      runtimeDir: found.runtimeDir, workspaceId: found.workspaceId } });
    return started.ok ? "ACC: live delivery is running for this conversation."
      : `ACC: live delivery did not start (${started.reason}); peers still reach this `
        + "conversation at its next turn.";
  } catch {
    return FAILED;
  }
}

/**
 * Start the relay's `run` child with the endpoint on its stdin, and wait for its
 * one ready line.
 *
 * Never throws and never waits longer than it must: a child that cannot start,
 * closes its input before reading it, exits before it is ready, or says nothing
 * within the budget is a closed failure. Every stream gets an error listener,
 * because a write to a child that already exited fails with EPIPE, and an
 * unheard stream error would crash `start` inside the agent's turn.
 */
export function spawnRelay({ command, args, env, payload, readyMs = 10_000, spawn = nodeSpawn }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve({ ok: false, reason: "could not start" });
      return;
    }
    let buffer = "";
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stdin?.destroy();
      child.unref();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false,
      reason: `no ready line within ${readyMs / 1000} seconds` }), readyMs);
    child.stdout.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try { finish(JSON.parse(buffer.slice(0, newline))); }
      catch { finish({ ok: false, reason: "unreadable ready line" }); }
    });
    child.stdout.on("error", () => finish({ ok: false, reason: "unreadable ready line" }));
    child.stdin.on("error", () => finish({ ok: false,
      reason: "the relay closed its input before reading it" }));
    child.on("error", () => finish({ ok: false, reason: "could not start" }));
    // After both pipes closed and the process exited: a ready line, if there
    // was one, has already settled this.
    child.on("close", () => finish({ ok: false, reason: "the relay exited before it was ready" }));
    child.stdin.end(JSON.stringify(payload));
  });
}
