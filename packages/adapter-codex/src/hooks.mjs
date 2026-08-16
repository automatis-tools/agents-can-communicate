import { normalizedEvent } from "@agents-can-communicate/adapter-sdk";
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
  const tool = pick(payload, FIELD_CANDIDATES.tool);
  return normalizedEvent({
    kind: KIND_BY_EVENT[event] ?? "other",
    sessionId,
    cwd,
    model: pick(payload, FIELD_CANDIDATES.model),
    parentSessionId: pick(payload, FIELD_CANDIDATES.parentSessionId),
    tool,
    targets: patchTargets(tool, payload?.tool_input),
  });
}

// This client's editor takes no path argument at all: the paths live inside the
// patch body, one per operation, so a single call can touch several files.
// Reading `tool_input.path` here - the shape every other harness uses - would
// find nothing and leave every edit unguarded.
const PATCH_OPERATION = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/;

/**
 * Paths an `apply_patch` call would write, read out of the patch envelope.
 *
 * A rename writes both sides, so both are returned. The `+`/`-` content lines
 * are never read: they are the file's contents, which ACC has no use for.
 */
export function patchTargets(tool, input) {
  if (tool !== "apply_patch") return [];
  const body = input?.command ?? input?.patch ?? input?.input;
  if (typeof body !== "string") return [];
  const targets = [];
  for (const line of body.split("\n")) {
    const operation = PATCH_OPERATION.exec(line) ?? PATCH_MOVE.exec(line);
    if (operation !== null) targets.push(operation[1].trim());
  }
  return targets;
}

/**
 * Deny a tool call the way this client understands it.
 *
 * Alone among the four, this one has no structured reply: a hook denies by
 * exiting 2 with the reason on stderr. Observed on 0.147.0 for both a shell
 * command and a file edit - the edit never reached disk, and the model reported
 * the reason back to the user in its own words.
 *
 * Returning JSON on stdout here, which is what the other three want, denies
 * nothing at all.
 */
export function denyOutcome(reason) {
  return { stdout: "", stderr: reason, exitCode: 2 };
}

export function allowOutcome() {
  return { stdout: "", stderr: "", exitCode: 0 };
}
