import http from "node:http";
import { versionOrder } from "@agents-can-communicate/adapter-sdk";

import { LOOPBACK_HOSTS, SERVER_ID, SESSION_ID } from "./web-contract.mjs";

// The loopback HTTP half of the `kimi web` transport, against the 2.4.0
// kap-server routes: every reply is a closed envelope `{code, msg, data,
// request_id}`, mapped errors arrive with HTTP 200 and a nonzero code, and
// only the auth hook answers with a real status (401, or 429 when its failure
// limiter bans the address). The token travels in the Authorization header of
// the single request it was read for and is never stored, logged, or put in
// an error.
//
// Every failure is classified by whether the request provably changed nothing
// (`definite`): the auth hook runs before any route, a refused connection
// never reached a server, and a mapped vendor error left the handler before
// any submit. Everything else - a timeout, a reset, a 5xx, an off-contract
// success body - is ambiguous, and only the caller can decide what a retry
// would mean.

const MAX_BYTES = 65_536;
const PROMPT_STATUS = Object.freeze(["running", "queued", "blocked"]);
// kap-server protocol/error-codes.ts, 2.4.0. Only the codes this transport
// can meet are named; an unknown nonzero code is off-contract.
const CODE_SESSION_NOT_FOUND = 40401;
const CODE_PROMPT_ID_COMPLETED = 40903;
const CODE_PROMPT_ID_CONFLICT = 40927;
const CODE_SESSION_OCCUPIED = 40931;
const CODE_SESSION_STALE = 40932;

export function httpRequest({ method, host, port, path, token = null, body = null,
  timeoutMs = 5_000 }) {
  if (!LOOPBACK_HOSTS.includes(host)) {
    return Promise.resolve({ error: Object.assign(new Error("Kimi Web endpoint is not loopback"),
      { code: "EACCES" }) });
  }
  return new Promise(resolve => {
    const headers = { accept: "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const request = http.request({ method, host, port, path, headers, agent: false },
      response => {
        const chunks = [];
        let size = 0;
        response.on("data", chunk => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            request.destroy(Object.assign(new Error("response too large"), { code: "ETOOBIG" }));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode,
          text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", error => resolve({ error }));
      });
    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error("kimi web request timed out"), { code: "ETIMEDOUT" }));
    });
    request.on("error", error => resolve({ error }));
    if (body !== null) request.write(body);
    request.end();
  });
}

const failure = (reason, definite) => ({ ok: false, reason, definite });

function transportFailure(error) {
  if (error?.code === "ETIMEDOUT") return failure("timeout", false);
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code)) {
    return failure("unavailable", true);
  }
  if (["EPERM", "EACCES"].includes(error?.code)) return failure("permission", true);
  return failure("reset", false);
}

// A closed envelope: the four fields every reply carries, plus the two a
// mapped error may add. Anything else is another protocol, not a bad reply.
function envelopeOf(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = ["code", "msg", "data", "request_id", "details", "stack"];
  if (!Object.keys(parsed).every(key => keys.includes(key))) return null;
  return Number.isInteger(parsed.code) && typeof parsed.msg === "string"
    && typeof parsed.request_id === "string" ? parsed : null;
}

async function call({ request, method, host, port, path, token, body, timeoutMs }) {
  const response = await request({ method, host, port, path, token, body, timeoutMs });
  if (response?.error !== undefined || response === null || typeof response.status !== "number") {
    return transportFailure(response?.error);
  }
  if (response.status === 401) return failure("unauthorized", true);
  if (response.status === 429) return failure("rate_limited", true);
  if (response.status !== 200) {
    return failure(response.status >= 500 ? "server_error" : "invalid", false);
  }
  const envelope = envelopeOf(response.text);
  if (envelope === null) return failure("invalid", false);
  if (envelope.code === 0) return { ok: true, data: envelope.data };
  // Mapped vendor errors arrive with HTTP 200; each named one left the route
  // before any state changed.
  if (envelope.code === CODE_SESSION_NOT_FOUND) return failure("session_not_found", true);
  if (envelope.code === CODE_PROMPT_ID_COMPLETED) return failure("prompt_id_completed", true);
  if (envelope.code === CODE_PROMPT_ID_CONFLICT) return failure("prompt_id_conflict", true);
  if ([CODE_SESSION_OCCUPIED, CODE_SESSION_STALE].includes(envelope.code)) {
    return failure("session_unavailable", true);
  }
  if (envelope.code >= 40_000 && envelope.code < 50_000) return failure("rejected", true);
  return failure("server_error", false);
}

/** The identity fields /api/v1/meta serves, validated closed, or null. */
export function validMeta(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = ["server_version", "capabilities", "server_id", "started_at", "open_in_apps",
    "dangerous_bypass_auth", "experimental_flags", "backend", "web_title", "features"];
  if (!Object.keys(data).every(key => keys.includes(key))) return null;
  const valid = typeof data.server_version === "string" && versionOrder(data.server_version) !== null
    && typeof data.server_id === "string" && SERVER_ID.test(data.server_id)
    && typeof data.started_at === "string" && Number.isFinite(Date.parse(data.started_at))
    && typeof data.dangerous_bypass_auth === "boolean";
  return valid ? { serverVersion: data.server_version, serverId: data.server_id,
    startedAtMs: Date.parse(data.started_at), dangerousBypassAuth: data.dangerous_bypass_auth } : null;
}

/** GET /api/v1/meta: the server's generation facts, or a classified failure. */
export async function getMeta({ host, port, token, timeoutMs = 5_000, request = httpRequest }) {
  const result = await call({ request, method: "GET", host, port, path: "/api/v1/meta", token,
    timeoutMs });
  if (!result.ok) return result;
  const meta = validMeta(result.data);
  return meta === null ? failure("invalid", false) : { ok: true, meta };
}

// Session metadata is the only warm-only liveness signal in 2.4.0: a live
// session exposes its model, while a reclaimed one has an empty model. The
// response also has summary fields such as last_prompt; they are never retained.
export async function getSessionFacts({ host, port, token, sessionId, timeoutMs = 5_000,
  request = httpRequest }) {
  if (!SESSION_ID.test(sessionId)) return failure("invalid", true);
  const result = await call({ request, method: "GET", host, port,
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}`, token, timeoutMs });
  if (!result.ok) return result;
  const data = result.data;
  const keys = ["id", "workspace_id", "title", "created_at", "updated_at", "archived_at", "busy",
    "main_turn_active", "pending_interaction", "last_turn_reason", "archived", "last_prompt",
    "metadata", "agent_config", "usage", "permission_rules", "message_count", "last_seq"];
  if (data === null || typeof data !== "object" || Array.isArray(data)
    || !Object.keys(data).every(key => keys.includes(key)) || data.id !== sessionId
    || typeof data.archived !== "boolean"
    || data.metadata === null || typeof data.metadata !== "object" || Array.isArray(data.metadata)
    || typeof data.metadata.cwd !== "string"
    || data.agent_config === null || typeof data.agent_config !== "object"
    || Array.isArray(data.agent_config) || typeof data.agent_config.model !== "string") {
    return failure("invalid", false);
  }
  return { ok: true, facts: { model: data.agent_config.model, cwd: data.metadata.cwd,
    archived: data.archived } };
}

/** Read only after a warm disk/lease check: this route also resumes cold sessions. */
export async function getSessionStatus({ host, port, token, sessionId, timeoutMs = 5_000,
  request = httpRequest }) {
  if (!SESSION_ID.test(sessionId)) return failure("invalid", true);
  const result = await call({ request, method: "GET", host, port,
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, token, timeoutMs });
  if (!result.ok) return result;
  const data = result.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)
    || !["manual", "yolo", "auto"].includes(data.permission)) return failure("invalid", false);
  return { ok: true, permission: data.permission };
}

function validPromptItem(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = ["prompt_id", "user_message_id", "status", "content", "created_at", "metadata"];
  const id = value => typeof value === "string" && value.length >= 1 && value.length <= 200;
  const valid = Object.keys(data).every(key => keys.includes(key))
    && id(data.prompt_id) && id(data.user_message_id)
    && PROMPT_STATUS.includes(data.status)
    && Array.isArray(data.content)
    && typeof data.created_at === "string" && Number.isFinite(Date.parse(data.created_at));
  return valid ? { promptId: data.prompt_id, status: data.status } : null;
}

/**
 * GET /api/v1/sessions/<id>/prompts. The route resolves the session through
 * resumeSessionById, so it is only safe after a warm disk verification: the
 * lock then proves the session is held, and the read cannot wake a cold one.
 */
export async function listPrompts({ host, port, token, sessionId, timeoutMs = 5_000,
  request = httpRequest }) {
  if (!SESSION_ID.test(sessionId)) return failure("invalid", true);
  const result = await call({ request, method: "GET", host, port,
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, token, timeoutMs });
  if (!result.ok) return result;
  const data = result.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)
    || !Object.keys(data).every(key => ["active", "queued"].includes(key))
    || !Array.isArray(data.queued) || data.queued.length > 100) return failure("invalid", false);
  const active = data.active === null ? null : validPromptItem(data.active);
  const queued = data.queued.map(validPromptItem);
  if ((data.active !== null && active === null) || queued.includes(null)) {
    return failure("invalid", false);
  }
  return { ok: true, prompts: { active, queued } };
}

/**
 * POST /api/v1/sessions/<id>/prompts with a wake: exactly the fixed notice as
 * one text part and the deterministic prompt id. No peer body, no steer, and
 * no model, profile, permission, or swarm field - a wake changes nothing
 * about how the session runs.
 */
export async function submitPrompt({ host, port, token, sessionId, promptId, text,
  timeoutMs = 5_000, request = httpRequest }) {
  if (!SESSION_ID.test(sessionId) || typeof promptId !== "string" || promptId === ""
    || promptId.length > 200 || typeof text !== "string" || text === "") {
    return failure("invalid", true);
  }
  const result = await call({ request, method: "POST", host, port,
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, token,
    body: JSON.stringify({ content: [{ type: "text", text }], prompt_id: promptId }), timeoutMs });
  if (!result.ok) return result;
  const item = validPromptItem(result.data);
  return item === null ? failure("invalid", false) : { ok: true, item };
}
