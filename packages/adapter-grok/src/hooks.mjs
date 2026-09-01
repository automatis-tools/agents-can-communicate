import { normalizedEvent, shellWriteTargets } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Event names Grok puts on stdin. The hook *file* uses Claude-style PascalCase
// keys (SessionStart); the payload uses camelCase keys and snake_case values
// (`hookEventName: "session_start"`). Both were taken from Grok 1.0.13 docs and
// from TUI hook_execution rows that named user_prompt_submit, pre_tool_use,
// post_tool_use, stop, and session_end.
export const GROK_HOOK_EVENTS = Object.freeze([
  "session_start", "session_end", "user_prompt_submit", "pre_tool_use", "post_tool_use",
  "post_tool_use_failure", "stop", "stop_failure", "stop_cancelled", "subagent_start",
  "subagent_stop", "pre_compact", "post_compact", "notification", "permission_denied",
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "Stop", "StopFailure", "StopCancelled", "SubagentStart",
  "SubagentStop", "PreCompact", "PostCompact", "Notification", "PermissionDenied",
]);

const KIND_BY_EVENT = Object.freeze({
  session_start: "sessionStart", SessionStart: "sessionStart",
  session_end: "sessionEnd", SessionEnd: "sessionEnd",
  user_prompt_submit: "beforeTurn", UserPromptSubmit: "beforeTurn",
  pre_tool_use: "beforeTool", PreToolUse: "beforeTool",
  post_tool_use: "afterTool", PostToolUse: "afterTool",
  post_tool_use_failure: "afterTool", PostToolUseFailure: "afterTool",
  stop: "turnEnd", Stop: "turnEnd",
  stop_failure: "turnEnd", StopFailure: "turnEnd",
  subagent_start: "childStart", SubagentStart: "childStart",
  subagent_stop: "childEnd", SubagentStop: "childEnd",
});

// Tool names from a real Grok 1.0.13 session (`pre_tool_use` logged `read_file`)
// and from the published PreToolUse example (`run_terminal_command`). Claude
// names (Write/Edit/Bash) are deliberately absent: a matcher copied from that
// client never fired on this one.
export const GROK_EDIT_TOOLS = Object.freeze(["write", "search_replace"]);
export const GROK_SHELL_TOOLS = Object.freeze(["run_terminal_command"]);

const field = (payload, camel, snake) => {
  if (typeof payload?.[camel] === "string" && payload[camel] !== "") return payload[camel];
  if (typeof payload?.[snake] === "string" && payload[snake] !== "") return payload[snake];
  return null;
};

const objectField = (payload, camel, snake) => {
  if (payload?.[camel] !== null && typeof payload?.[camel] === "object") return payload[camel];
  if (payload?.[snake] !== null && typeof payload?.[snake] === "object") return payload[snake];
  return null;
};

/**
 * Normalise a Grok hook payload.
 *
 * A whitelist, not a filter. Grok's stdin carries `lastAssistantMessage` on
 * Stop, the user prompt on UserPromptSubmit, and tool output on PostToolUse.
 * None of it may survive. Keys are camelCase on the native path; snake_case is
 * accepted so a payload that leaked through Claude-compat still identifies the
 * session rather than attaching a new one every event.
 */
export function normalizeGrokHook(payload) {
  const event = field(payload, "hookEventName", "hook_event_name");
  if (event === null || !GROK_HOOK_EVENTS.includes(event)) {
    throw new AccError(EXIT.DATA, "unrecognised Grok hook event",
      { event: event ?? null });
  }
  const sessionId = field(payload, "sessionId", "session_id");
  const cwd = typeof payload?.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;
  if (sessionId === null || cwd === null) {
    throw new AccError(EXIT.DATA, "hook payload has no session id or working directory",
      { event, received: Object.keys(payload ?? {}) });
  }
  const tool = field(payload, "toolName", "tool_name");
  return normalizedEvent({
    kind: KIND_BY_EVENT[event] ?? "other",
    sessionId,
    cwd,
    model: typeof payload.model === "string" ? payload.model : null,
    // SubagentStart exists on this client. No subagent ran during capture, so
    // nothing is invented from `subagentType`.
    parentSessionId: null,
    tool,
    targets: writeTargets(tool, objectField(payload, "toolInput", "tool_input")),
  });
}

function writeTargets(tool, input) {
  if (GROK_SHELL_TOOLS.includes(tool)) return shellWriteTargets(input?.command);
  if (!GROK_EDIT_TOOLS.includes(tool)) return [];
  const target = input?.file_path;
  return typeof target === "string" && target !== "" ? [target] : [];
}

/**
 * Deny a tool call in the shape Grok 1.0.13 documents for PreToolUse.
 *
 * Not yet captured stopping a real write or shell call on this client, so the
 * adapter does not claim `guards.beforeWrite` / `beforeShell`. The documented
 * form is still what the runner must emit if a claim is held: a Claude-shaped
 * envelope that this client does not need.
 */
export function denyResponse(reason) {
  return { decision: "deny", reason };
}

export function allowResponse() {
  return {};
}

/**
 * Context for the next turn.
 *
 * Grok 1.0.13 discards UserPromptSubmit stdout / additionalContext. The
 * envelope is still Claude-compatible so a later client that does unwrap it
 * will not start dumping JSON into the conversation. Delivery until then is
 * the skill, not this hook.
 */
export function injectResponse(context) {
  return context === "" ? {} : { hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: context } };
}

export function denyOutcome(reason) {
  return { stdout: `${JSON.stringify(denyResponse(reason))}\n`, stderr: "", exitCode: 0 };
}

export function injectOutcome(context) {
  return { stdout: `${JSON.stringify(injectResponse(context))}\n`, stderr: "", exitCode: 0 };
}
