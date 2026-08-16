import { AccError, EXIT } from "@agents-can-communicate/protocol";

// The event names are settled: they are an enum in the installed 0.147.0 binary,
// listed in packages/adapter-codex/COMPATIBILITY.md. What is not settled is the
// payload a hook receives on stdin - nothing published or bundled describes it,
// and the binary's HookRunSummary describes a hook's result rather than its
// input.
export const CODEX_HOOK_EVENTS = Object.freeze(["PreToolUse", "PermissionRequest",
  "PostToolUse", "PreCompact", "PostCompact", "SessionStart", "SessionEnd",
  "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop"]);

const KIND_BY_EVENT = Object.freeze({
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "beforeTurn",
  PreToolUse: "beforeTool",
  PostToolUse: "afterTool",
  Stop: "turnEnd",
  SubagentStart: "childStart",
  SubagentStop: "childEnd",
});

// Field names are read from a capture rather than assumed. A capture is a real
// payload recorded from a real Codex session; see fixtures/README.md.
const FIELD_CANDIDATES = Object.freeze({
  sessionId: ["session_id", "sessionId", "thread_id", "threadId"],
  cwd: ["cwd", "working_directory", "workspace_root"],
  model: ["model", "model_slug"],
  parentSessionId: ["parent_thread_id", "parentSessionId", "parent_session_id"],
  tool: ["tool_name", "toolName", "tool"],
  event: ["hook_event_name", "eventName", "event_name"],
});

const pick = (payload, names) => {
  for (const name of names) {
    if (typeof payload?.[name] === "string" && payload[name] !== "") return payload[name];
  }
  return null;
};

/**
 * Normalise a Codex hook payload.
 *
 * This refuses to guess. If the payload does not carry a recognised event name
 * and session identifier, it throws rather than inventing a session - an
 * adapter that silently normalises an unrecognised shape would attach the wrong
 * session, or a new one on every hook, and look like it was working.
 */
export function normalizeCodexHook(payload) {
  const event = pick(payload, FIELD_CANDIDATES.event);
  if (event === null || !CODEX_HOOK_EVENTS.includes(event)) {
    throw new AccError(EXIT.DATA,
      "unrecognised Codex hook payload: no known event field", { received: payload });
  }
  const sessionId = pick(payload, FIELD_CANDIDATES.sessionId);
  const cwd = pick(payload, FIELD_CANDIDATES.cwd);
  if (sessionId === null || cwd === null) {
    throw new AccError(EXIT.DATA,
      "unrecognised Codex hook payload: no session id or working directory",
      { event, received: Object.keys(payload ?? {}) });
  }
  return {
    kind: KIND_BY_EVENT[event] ?? "other",
    sessionId,
    cwd,
    model: pick(payload, FIELD_CANDIDATES.model),
    parentSessionId: pick(payload, FIELD_CANDIDATES.parentSessionId),
    tool: pick(payload, FIELD_CANDIDATES.tool),
  };
}
