import { AccError, EXIT } from "@agents-can-communicate/protocol";

// The shape every adapter normalises to. Kept here rather than in each adapter
// so the four cannot drift: a consumer that has to ask which adapter produced an
// event is a consumer that will eventually get it wrong.
export const NORMALIZED_EVENT_KEYS = Object.freeze(["kind", "sessionId", "cwd", "model",
  "parentSessionId", "tool", "targets", "permissionMode", "endReason"]);

export const EVENT_KINDS = Object.freeze(["sessionStart", "sessionEnd", "heartbeat",
  "beforeTurn", "beforeTool", "afterTool", "turnEnd", "childStart", "childEnd", "other"]);

const data = (message, details) => {
  throw new AccError(EXIT.DATA, message, details);
};

/**
 * Build a normalised hook event.
 *
 * `targets` is the list of paths the call would write. It is a resource
 * identifier, not conversation content: without it a guard has nothing to
 * compare against a claim, and a declared write guard protects nothing. What is
 * deliberately *not* here is the file's contents, the command text, the prompt
 * and the transcript path - all of which the harnesses hand to hooks, and none
 * of which ACC needs.
 *
 * A call whose targets cannot be determined declares none. Guessing a path from
 * a shell command would produce a guard that is wrong in both directions: it
 * would block work it has no claim over and miss writes it does.
 */
export function normalizedEvent(fields) {
  for (const key of Object.keys(fields)) {
    if (!NORMALIZED_EVENT_KEYS.includes(key)) {
      data(`unknown normalised event field: ${key}`, { key });
    }
  }
  const { kind, sessionId, cwd, model = null, parentSessionId = null, tool = null,
    targets = [], permissionMode = null, endReason = null } = fields;

  if (!EVENT_KINDS.includes(kind)) data("unknown normalised event kind", { kind });
  if (typeof sessionId !== "string" || sessionId === "") {
    data("normalised event has no session id", { kind });
  }
  if (typeof cwd !== "string" || cwd === "") {
    data("normalised event has no working directory", { kind });
  }
  if (!Array.isArray(targets)) data("normalised event targets must be an array", { kind });
  for (const target of targets) {
    if (typeof target !== "string" || target === "") {
      data("normalised event target must be a non-empty string", { kind, target });
    }
  }

  // The client's own name for the session's permission mode, when its hook
  // reports one. Only a native binding reads it, to tell a sender whether the
  // client will hold a wake for approval.
  if (permissionMode !== null && (typeof permissionMode !== "string" || permissionMode === "")) {
    data("normalised event permission mode must be a non-empty string", { kind });
  }

  // Why the client ended the session, in its own words, when it says. A sender
  // is told a conversation was cleared rather than that its peer vanished.
  if (endReason !== null && (typeof endReason !== "string" || endReason === "")) {
    data("normalised event end reason must be a non-empty string", { kind });
  }

  return Object.freeze({ kind, sessionId, cwd, model, parentSessionId, tool,
    targets: Object.freeze([...targets]), permissionMode, endReason });
}
