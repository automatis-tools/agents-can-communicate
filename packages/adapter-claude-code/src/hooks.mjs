import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Confirmed by capture on 2.1.233, and matching the published documentation
// exactly - unlike Codex, where nothing was published and the tool vocabulary
// turned out to differ.
export const CLAUDE_HOOK_EVENTS = Object.freeze(["SessionStart", "Setup",
  "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PermissionRequest",
  "PostToolUse", "Stop", "SessionEnd", "SubagentStart", "SubagentStop", "Notification",
  "PreCompact", "PostCompact"]);

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

/**
 * Normalise a Claude Code hook payload.
 *
 * A whitelist, not a filter. Every payload carries `transcript_path`,
 * `UserPromptSubmit` carries the raw prompt, and `Stop` carries the model's last
 * message: this client hands conversation content to hooks directly, so "raw
 * transcripts are not collected" is a property of this function rather than an
 * absence of opportunity.
 */
export function normalizeClaudeHook(payload) {
  const event = payload?.hook_event_name;
  if (typeof event !== "string" || !CLAUDE_HOOK_EVENTS.includes(event)) {
    throw new AccError(EXIT.DATA, "unrecognised Claude Code hook event",
      { event: event ?? null });
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
    // agent_id and agent_type are documented on subagent calls, so a child
    // session is mapped from metadata rather than guessed from timing.
    parentSessionId: typeof payload.agent_id === "string" ? payload.session_id : null,
    tool: typeof payload.tool_name === "string" ? payload.tool_name : null,
  };
}

/**
 * Render a hook response in this client's exact structured-output shape.
 *
 * A guard that denies must say so in the form the client understands, or the
 * tool runs anyway and the adapter reports protection it never applied.
 */
export function denyResponse(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "deny", permissionDecisionReason: reason } };
}

export function allowResponse() {
  return {};
}

export function injectResponse(context) {
  // Observed reaching the model: a UserPromptSubmit hook's additionalContext
  // appears in the session as data, not as an instruction from ACC.
  return context === "" ? {} : { hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: context } };
}
