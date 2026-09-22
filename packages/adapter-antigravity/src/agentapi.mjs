import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * The one way ACC talks to a running Antigravity session: `agy agentapi`, run as
 * a child whose environment - and only whose environment - carries the session
 * endpoint. argv is readable by every process on the machine, so the token is
 * never an argument; the environment of a short-lived child is the exposure
 * every command the agent itself runs already has.
 *
 * Answer shapes are the ones captured on 1.2.7: a delivered message comes back
 * as `response.sendMessage.recipientId`; a gone session as
 * `code = Unavailable`; a refused credential as `code = Unauthenticated`.
 */
export const ENDPOINT_VARIABLES = Object.freeze(["ANTIGRAVITY_LS_ADDRESS",
  "ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_CONVERSATION_ID"]);
const TITLE = "ACC peer message";

export function endpointFrom(env) {
  const [lsAddress, csrfToken, conversationId] = ENDPOINT_VARIABLES.map(name => env?.[name]);
  return [lsAddress, csrfToken, conversationId].every(value => typeof value === "string"
    && value !== "") ? { lsAddress, csrfToken, conversationId } : null;
}

export function childEnv(baseEnv, endpoint) {
  const env = { ...baseEnv };
  for (const name of ENDPOINT_VARIABLES) delete env[name];
  return { ...env, ANTIGRAVITY_LS_ADDRESS: endpoint.lsAddress,
    ANTIGRAVITY_CSRF_TOKEN: endpoint.csrfToken,
    ANTIGRAVITY_CONVERSATION_ID: endpoint.conversationId };
}

export function classifyAnswer(stdout, conversationId) {
  let answer;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return { ok: false, reasonCode: "transport_error" };
  }
  const sent = answer?.response?.sendMessage;
  if (sent !== undefined) {
    return sent.recipientId === conversationId ? { ok: true, reasonCode: null }
      : { ok: false, reasonCode: "transport_rejected" };
  }
  if (answer?.response?.conversationMetadata !== undefined) return { ok: true, reasonCode: null };
  const error = typeof answer?.error === "string" ? answer.error : "";
  if (/code = Unavailable/.test(error)) return { ok: false, reasonCode: "recipient_unavailable" };
  if (/code = (Unauthenticated|PermissionDenied)/.test(error)) {
    return { ok: false, reasonCode: "transport_rejected" };
  }
  return { ok: false, reasonCode: "transport_error" };
}

export function run(command, args, { env, timeout }) {
  return new Promise(resolve => {
    execFile(command, args, { env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (_error, stdout) => resolve({ stdout: String(stdout ?? "") }));
  });
}

export function createAgentApi({ endpoint, baseEnv = process.env, run: runner = run,
  command = "agy", timeoutMs = 4_000 }) {
  const call = async args => {
    try {
      const { stdout } = await runner(command, ["agentapi", ...args],
        { env: childEnv(baseEnv, endpoint), timeout: timeoutMs });
      return classifyAnswer(stdout, endpoint.conversationId);
    } catch {
      return { ok: false, reasonCode: "transport_error" };
    }
  };
  return {
    sendMessage: text => call(["send-message", "--title", TITLE, endpoint.conversationId, text]),
    conversationMetadata: () => call(["get-conversation-metadata", endpoint.conversationId]),
  };
}

/**
 * The agy the relay runs. The agent's shell names the client's own binary in
 * ANTIGRAVITY_AGENTAPI_EXE - captured as the same file as the agy on its PATH -
 * and preferring it keeps a push working for a client started by a full path
 * that is not on the PATH. Only an absolute, executable file named agy is
 * taken, because the relay calls it as `agy agentapi ...`; anything else falls
 * back to the PATH.
 */
export function agentApiCommand(env) {
  const named = env?.ANTIGRAVITY_AGENTAPI_EXE;
  if (typeof named !== "string" || !path.isAbsolute(named) || path.basename(named) !== "agy") {
    return "agy";
  }
  try {
    accessSync(named, constants.X_OK);
    return statSync(named).isFile() ? named : "agy";
  } catch {
    return "agy";
  }
}
