import { AccError, EXIT } from "./errors.mjs";

export const RECEIPT_STATES = Object.freeze(
  ["queued", "offered", "retrieved", "acknowledged"]);

const RECEIPT_NEXT = Object.freeze({
  queued: ["offered", "retrieved", "acknowledged"],
  offered: ["retrieved", "acknowledged"],
  retrieved: ["acknowledged"],
  acknowledged: [],
});

export function advanceReceipt(current, next) {
  if (!RECEIPT_STATES.includes(current)) {
    throw new AccError(EXIT.DATA, `unknown receipt state: ${String(current)}`,
      { current, next });
  }
  if (!RECEIPT_STATES.includes(next)) {
    throw new AccError(EXIT.DATA, `unknown receipt state: ${String(next)}`,
      { current, next });
  }
  if (current === next) return next;
  if (!RECEIPT_NEXT[current].includes(next)) {
    throw new AccError(EXIT.CONFLICT,
      `illegal receipt transition from ${current} to ${next}`, { current, next });
  }
  return next;
}
