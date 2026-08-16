import { normalizedEvent } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

// All eight observed in a live 0.37.0 configuration; the six that ACC uses were
// observed firing with real payloads. BeforeTool, AfterTool and AfterAgent were
// the ones missing for a long time, because the capture account received HTTP
// 403 from the model API and no turn ever ran. A local stand-in endpoint served
// one canned turn instead, which is all it took.
export const GEMINI_HOOK_EVENTS = Object.freeze(["SessionStart", "BeforeAgent",
  "BeforeTool", "AfterTool", "AfterAgent", "SessionEnd", "Notification", "PreCompress"]);

// This client's own names, read out of the tool declarations it sends the model.
// It offers write_file and replace for edits and run_shell_command for shell -
// none of which look like Codex's apply_patch or Claude Code's Write/Edit/Bash.
export const GEMINI_EDIT_TOOLS = Object.freeze(["write_file", "replace"]);
export const GEMINI_SHELL_TOOLS = Object.freeze(["run_shell_command"]);

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
 * `transcript_path`, `BeforeAgent` carries the raw prompt, `AfterAgent` carries
 * the model's answer and `AfterTool` the tool's output. Keeping all of it out of
 * coordination state is this function's job.
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
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
  return normalizedEvent({
    kind: KIND_BY_EVENT[event] ?? "other",
    sessionId: payload.session_id,
    cwd: payload.cwd,
    model: null,
    parentSessionId: null,
    tool,
    targets: writeTargets(tool, payload.tool_input),
  });
}

/**
 * The paths a tool call would write.
 *
 * Both editing tools take `file_path`, confirmed from a capture. The file's
 * contents are not read: they are conversation content.
 *
 * `run_shell_command` declares nothing. A command can write anywhere, and a path
 * guessed out of one gives a guard that is wrong in both directions.
 */
function writeTargets(tool, input) {
  if (!GEMINI_EDIT_TOOLS.includes(tool)) return [];
  const target = input?.file_path;
  return typeof target === "string" && target !== "" ? [target] : [];
}

/**
 * Deny a tool call in the shape this client acts on.
 *
 * Five candidate replies were run against a real session. Only exit code 2 and
 * this one stopped the tool. Notably the shape Claude Code and Kimi Code both
 * accept - `hookSpecificOutput.permissionDecision` - does **not** deny here: the
 * write went through every time. A deny copied between harnesses is the exact
 * failure this adapter exists to prevent.
 */
export function denyResponse(reason) {
  return { decision: "block", reason };
}

export function allowResponse() {
  return {};
}

/**
 * Context for the next turn.
 *
 * The opposite of the deny contract: here the `hookSpecificOutput` envelope is
 * the one that works, and a bare string or `{"additionalContext": ...}` is
 * dropped silently. The client unwraps it and appends the text to the user turn
 * as `<hook_context>...</hook_context>`, so it reaches the model as data.
 */
export function injectResponse(context) {
  return context === "" ? {} : { hookSpecificOutput: {
    hookEventName: "BeforeAgent", additionalContext: context } };
}
