import { normalizedEvent } from "@agents-can-communicate/adapter-sdk";
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
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
  return normalizedEvent({
    kind: KIND_BY_EVENT[event] ?? "other",
    sessionId: payload.session_id,
    cwd: payload.cwd,
    model: null,
    // agent_id and agent_type are documented on subagent calls, so a child
    // session is mapped from metadata rather than guessed from timing.
    parentSessionId: typeof payload.agent_id === "string" ? payload.session_id : null,
    tool,
    targets: writeTargets(tool, payload.tool_input),
  });
}

// Confirmed by capture on 2.1.233: Write takes `file_path` and `content`, Edit
// takes `file_path` with `old_string`/`new_string`. Read also takes `file_path`
// and is deliberately absent - reading is not a write, and treating it as one
// would have sessions blocking each other for looking.
export const CLAUDE_EDIT_TOOLS = Object.freeze(["Write", "Edit", "MultiEdit",
  "NotebookEdit"]);

/**
 * The paths a tool call would write.
 *
 * Only the path is taken. `content`, `old_string` and `new_string` are the
 * file's contents, which ACC has no use for and must not carry.
 *
 * `Bash` declares nothing: a command can write anywhere, and a path guessed out
 * of one gives a guard that is wrong in both directions.
 */
function writeTargets(tool, input) {
  if (!CLAUDE_EDIT_TOOLS.includes(tool)) return [];
  const target = input?.file_path ?? input?.notebook_path;
  return typeof target === "string" && target !== "" ? [target] : [];
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
