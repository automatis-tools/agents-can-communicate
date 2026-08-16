import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Observed in a live 0.37.0 configuration and, for the four marked, observed
// firing. BeforeTool, AfterTool and AfterAgent are configurable and accepted by
// the client but were never seen firing here, because the account could not
// reach the model API.
export const GEMINI_HOOK_EVENTS = Object.freeze(["SessionStart", "BeforeAgent",
  "BeforeTool", "AfterTool", "AfterAgent", "SessionEnd", "Notification", "PreCompress"]);

const KIND_BY_EVENT = Object.freeze({
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  BeforeAgent: "beforeTurn",
  BeforeTool: "beforeTool",
  AfterTool: "afterTool",
  AfterAgent: "turnEnd",
});

/**
 * Normalise a Gemini CLI hook payload.
 *
 * A whitelist for the same reason as the other adapters: every payload carries
 * `transcript_path` and `BeforeAgent` carries the raw prompt, so keeping
 * conversation content out of coordination state is this function's job.
 */
export function normalizeGeminiHook(payload) {
  const event = payload?.hook_event_name;
  if (typeof event !== "string" || !GEMINI_HOOK_EVENTS.includes(event)) {
    throw new AccError(EXIT.DATA, "unrecognised Gemini hook event", { event: event ?? null });
  }
  if (typeof payload.session_id !== "string" || typeof payload.cwd !== "string") {
    throw new AccError(EXIT.DATA, "hook payload has no session id or working directory",
      { event, received: Object.keys(payload) });
  }
  return {
    kind: KIND_BY_EVENT[event] ?? "other",
    sessionId: payload.session_id,
    cwd: payload.cwd,
    model: null,
    parentSessionId: null,
    tool: typeof payload.tool_name === "string" ? payload.tool_name : null,
  };
}
