import { AccError, EXIT } from "./errors.mjs";

// recorded -> queued -> injected -> seen -> acknowledged, with failed branching
// off before the message was ever exposed. States are monotonic: one
// recipient's receipt can only move forwards, and never rewrites another
// recipient's state.
export const DELIVERY_STATES = Object.freeze(
  ["recorded", "queued", "injected", "seen", "acknowledged", "failed"]);

const DELIVERY_NEXT = Object.freeze({
  recorded: ["queued", "injected", "seen", "acknowledged", "failed"],
  queued: ["injected", "seen", "acknowledged", "failed"],
  injected: ["seen", "acknowledged"],
  seen: ["acknowledged"],
  acknowledged: [],
  failed: [],
});

export const TASK_STATES = Object.freeze(
  ["pending", "in_progress", "review", "done", "blocked"]);

const TASK_NEXT = Object.freeze({
  pending: ["in_progress", "blocked"],
  in_progress: ["review", "done", "blocked"],
  review: ["in_progress", "done", "blocked"],
  blocked: ["pending", "in_progress"],
  done: [],
});

function step(machine, allowed, label, current, next) {
  if (!machine.includes(current)) {
    throw new AccError(EXIT.DATA, `unknown ${label} state: ${String(current)}`,
      { current, next });
  }
  if (!machine.includes(next)) {
    throw new AccError(EXIT.DATA, `unknown ${label} state: ${String(next)}`,
      { current, next });
  }
  // Re-declaring the current state is idempotent. Adapters retry at safe
  // points, and a repeated receipt is not a protocol violation.
  if (current === next) return next;
  if (!allowed[current].includes(next)) {
    throw new AccError(EXIT.CONFLICT,
      `illegal ${label} transition from ${current} to ${next}`, { current, next });
  }
  return next;
}

export function advanceDelivery(current, next) {
  return step(DELIVERY_STATES, DELIVERY_NEXT, "delivery", current, next);
}

export function transitionTask(current, next) {
  return step(TASK_STATES, TASK_NEXT, "task", current, next);
}
