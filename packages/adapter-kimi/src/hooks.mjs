import { normalizedEvent } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Not read from documentation and not guessed: this client validates its config
// with a strict schema, and rejecting an empty hook entry makes it name every
// accepted event. See COMPATIBILITY.md for the transcript.
export const KIMI_HOOK_EVENTS = Object.freeze(["PreToolUse", "PostToolUse",
  "PostToolUseFailure", "PermissionRequest", "PermissionResult", "UserPromptSubmit",
  "UserPromptQueued", "TurnStarted", "Stop", "StopFailure", "Interrupt", "SessionStart",
  "SessionEnd", "SessionHeartbeat", "SubagentStart", "SubagentStop", "TaskStarted",
  "PreCompact", "PostCompact", "Notification"]);

// The tools this client actually names. Codex calls its editor apply_patch, and
// a matcher borrowed across harnesses guards nothing at all, so these were read
// out of a real request rather than assumed from the family resemblance.
export const KIMI_EDIT_TOOLS = Object.freeze(["Write", "Edit"]);
export const KIMI_SHELL_TOOLS = Object.freeze(["Bash"]);

const KIND_BY_EVENT = Object.freeze({
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  SessionHeartbeat: "heartbeat",
  UserPromptSubmit: "beforeTurn",
  PreToolUse: "beforeTool",
  PostToolUse: "afterTool",
  PostToolUseFailure: "afterTool",
  Stop: "turnEnd",
  StopFailure: "turnEnd",
  SubagentStart: "childStart",
  SubagentStop: "childEnd",
});

/**
 * Normalise a Kimi Code hook payload.
 *
 * A whitelist, not a filter. `TurnStarted` carries the raw prompt, and
 * `UserPromptSubmit` carries it as content blocks; `PostToolUse` carries the
 * tool's output and `PostToolUseFailure` the error text. This client hands
 * conversation content to hooks directly, so keeping it out is a property of
 * this function rather than an absence of opportunity.
 */
export function normalizeKimiHook(payload) {
  const event = payload?.hook_event_name;
  if (typeof event !== "string" || !KIMI_HOOK_EVENTS.includes(event)) {
    throw new AccError(EXIT.DATA, "unrecognised Kimi Code hook event",
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
    // Only SessionStart carries it; every other event leaves it null rather
    // than inheriting a stale value.
    model: typeof payload.model === "string" ? payload.model : null,
    // No subagent was observed running, so there is no field to map yet and
    // nothing is invented from timing.
    parentSessionId: null,
    tool,
    targets: writeTargets(tool, payload.tool_input),
  });
}

/**
 * The paths a tool call would write.
 *
 * Both editing tools take `path` - confirmed from their declared schemas, where
 * `Write` requires `path` and `content` and `Edit` requires `path`,
 * `old_string` and `new_string`. Nothing else is read: the contents and the
 * replacement strings are conversation content and stay out.
 *
 * `Bash` declares nothing. A command can write anywhere, and a path guessed out
 * of one would give a guard that blocks work it holds no claim over while
 * missing writes it does.
 */
function writeTargets(tool, input) {
  if (!KIMI_EDIT_TOOLS.includes(tool)) return [];
  const path = input?.path;
  return typeof path === "string" && path !== "" ? [path] : [];
}

/**
 * Deny a tool call in the one shape this client acts on.
 *
 * Five candidate shapes were run against a real session. Only two stopped the
 * tool: exit code 2, and this structured reply. `{"decision":"block"}`,
 * `{"permission":"deny"}` and exit code 1 all looked plausible and let the write
 * through. This one is preferred over exit 2 because the reason survives: it
 * reaches the model as the failed call's `error.message`.
 */
export function denyResponse(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "deny", permissionDecisionReason: reason } };
}

export function allowResponse() {
  return {};
}

/**
 * Context for the next turn, as this client delivers it.
 *
 * Unlike Claude Code, this client does not unwrap `additionalContext`: it wraps
 * a hook's entire stdout in `<hook_result hook_event="...">` and shows the model
 * whatever that was. Emitting the JSON envelope here would put the envelope
 * itself into the conversation, so the injection is plain text.
 */
export function injectResponse(context) {
  return context === "" ? null : context;
}

// How a denial and an injection reach this client. Both were measured; they use
// different mechanisms, and neither matches all three of the other adapters.
export function denyOutcome(reason) {
  return { stdout: `${JSON.stringify(denyResponse(reason))}\n`, stderr: "", exitCode: 0 };
}

export function injectOutcome(context) {
  const rendered = injectResponse(context);
  return { stdout: rendered === null ? "" : `${rendered}\n`, stderr: "", exitCode: 0 };
}
