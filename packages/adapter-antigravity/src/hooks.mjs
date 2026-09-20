import { normalizedEvent } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

/**
 * The events that load on this client. Captured on 1.2.7 by registering each
 * one alone and then together, and reading the effective list back from
 * `agy -p "/hooks" --output-format json`.
 *
 * The list is short because most of what an adapter would want is not here.
 * There is no tool event, so no guard; and no session end, so no lifecycle
 * deregistration. See COMPATIBILITY.md.
 */
export const ANTIGRAVITY_HOOK_EVENTS = Object.freeze(["SessionStart", "PreInvocation",
  "PostInvocation", "Stop"]);

/**
 * Names this client accepts into a config file and then silently drops.
 *
 * Nothing is logged, no error is produced, and `/hooks` reports an empty list.
 * That is the single most important failure mode here, so the names are kept
 * rather than merely absent: an install that writes one of them succeeds on
 * disk and registers nothing, and the only defence is to refuse the name in
 * both directions - never write it, and never normalise it if it somehow
 * arrives.
 *
 * `SessionEnd`, `PreToolUse`, `PostToolUse`, `Notification` and
 * `turn-completion` were each registered and never fired; `turn-completion`
 * does not appear in the 1.2.7 binary at all. The last four are the Gemini CLI
 * names, which matter because both clients share `~/.gemini`.
 */
export const ANTIGRAVITY_INERT_EVENTS = Object.freeze(["SessionEnd", "PreToolUse",
  "PostToolUse", "Notification", "turn-completion",
  "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool"]);

/**
 * How many times this adapter will continue one turn.
 *
 * One. The vendor caps consecutive continuations itself - changelog 1.1.9 fixed
 * "stop hooks that always block hanging the agent forever" - but the cap is
 * configurable and its value was not captured, so relying on it would be
 * relying on a number nobody here has read. One is also the whole of what was
 * observed: `executionNum` 0 continued into `executionNum` 1, and that pair is
 * the evidence this ceiling rests on.
 *
 * A continuation is a nudge, not a gate. Nothing about it guarantees a peer is
 * answered, and the sender-facing story must not say otherwise.
 */
export const STOP_CONTINUATION_CEILING = 1;

const KIND_BY_EVENT = Object.freeze({
  SessionStart: "sessionStart",
  PreInvocation: "beforeTurn",
  // Recorded rather than used. It fires after each invocation with an envelope
  // byte-identical to PreInvocation's, and there is nothing ACC does at that
  // point that PreInvocation has not already done.
  PostInvocation: "other",
  Stop: "turnEnd",
});

const data = (message, details) => {
  throw new AccError(EXIT.DATA, message, details);
};

/**
 * Normalise an Antigravity CLI hook payload.
 *
 * The event name is an argument, never a payload field. This client sends no
 * `hook_event_name`, and `PreInvocation` and `PostInvocation` hand over
 * byte-identical envelopes for the same invocation - so a payload alone cannot
 * say which of the two ran. The command registered for each event carries its
 * own name, and that is the only thing that knows.
 *
 * A whitelist, for the reason every adapter uses one: the payload carries
 * `transcriptPath` and `artifactDirectoryPath`, both of which lead to the
 * conversation. Neither survives this function.
 */
export function normalizeAntigravityHook(payload, { args = [] } = {}) {
  const event = args[0];
  if (typeof event !== "string" || !ANTIGRAVITY_HOOK_EVENTS.includes(event)) {
    data("unrecognised Antigravity hook event", { event: event ?? null });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    data("Antigravity hook payload is not an object", { event });
  }
  if (typeof payload.conversationId !== "string" || payload.conversationId === "") {
    data("hook payload has no conversation id",
      { event, received: Object.keys(payload) });
  }
  // The only working directory this client offers. `workspacePaths` is an array
  // because a session can hold several; the first is the one the conversation
  // was opened against, and ACC's workspace identity needs exactly one.
  const cwd = Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : undefined;
  if (typeof cwd !== "string" || cwd === "") {
    data("hook payload has no workspace path", { event, received: Object.keys(payload) });
  }
  return normalizedEvent({
    kind: KIND_BY_EVENT[event],
    sessionId: payload.conversationId,
    cwd,
    model: typeof payload.modelName === "string" ? payload.modelName : null,
    parentSessionId: null,
    // This client runs no tool hook, so there is never a tool to name and never
    // a target to guard. Declared empty rather than left to a default, because
    // a future reader will want to know it was measured.
    tool: null,
    targets: [],
  });
}

/**
 * Context for the next invocation.
 *
 * Measured, not copied: returning this from `PreInvocation` put the text where
 * the model read it, and the model reproduced the probe token in its reply. The
 * client's `userMessage` and `toolCall` injection types exist in the binary and
 * were not exercised, so neither is used here.
 */
export function injectResponse(context) {
  return context === "" || context === undefined || context === null
    ? {} : { injectSteps: [{ ephemeralMessage: String(context) }] };
}

/**
 * Whether to hold this turn open, and why.
 *
 * `continue` is the exact string; any other value, including `block` and
 * `stop`, permits shutdown. The `reason` reaches the model as prompt text - the
 * model reproduced a token carried in it - so this is a delivery path as well
 * as a decision.
 *
 * Everything that is not a good reason below the ceiling releases the turn.
 * That is deliberate and it is the whole fail-open rule in one expression: a
 * hook error, an expired budget and an unreachable store all arrive here as an
 * absent reason, and none of them may be the cause of a session that will not
 * finish.
 */
export function stopResponse(input) {
  const reason = input?.reason;
  const executionNum = input?.executionNum;
  if (typeof reason !== "string" || reason.trim() === "") return {};
  if (!Number.isInteger(executionNum) || executionNum < 0) return {};
  if (executionNum >= STOP_CONTINUATION_CEILING) return {};
  return { decision: "continue", reason };
}

export function injectOutcome(context) {
  const response = injectResponse(context);
  return { stdout: Object.keys(response).length === 0 ? "" : `${JSON.stringify(response)}\n`,
    stderr: "", exitCode: 0 };
}

export function stopOutcome(input) {
  const response = stopResponse(input);
  // Printing nothing is how a turn is allowed to end. An empty object would do
  // the same thing, but silence cannot be mistaken later for a decision.
  return { stdout: Object.keys(response).length === 0 ? "" : `${JSON.stringify(response)}\n`,
    stderr: "", exitCode: 0 };
}

/**
 * There is no deny on this client.
 *
 * No tool event loads, so nothing ever reaches a guard, and no shape was ever
 * found that stops a tool call. This exists because the hook runtime asks every
 * adapter how it denies, and the honest answer here is that it cannot: the call
 * is allowed and the reason goes to stderr where an operator can read it.
 *
 * It must never return a deny envelope copied from another client. A shape that
 * does nothing, printed as though it did something, is exactly the silent
 * failure this package documents.
 */
export function denyOutcome(reason) {
  return { stdout: "", stderr: `acc: ${reason} (this client has no tool guard)`, exitCode: 0 };
}
