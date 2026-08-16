// Numeric slots are a compatibility contract, not an implementation detail:
// scripts and adapters branch on them. Slot 3 stays TIMEOUT and slot 6 carries
// the meaning the reconciled prototype called REQUIRED, so ported process tests
// keep their exit-code semantics after the rename to ATTENTION.
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  TIMEOUT: 3,
  DATA: 4,
  CONFLICT: 5,
  ATTENTION: 6,
});

const CODES = new Set(Object.values(EXIT));

export class AccError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    if (!CODES.has(code)) {
      throw new TypeError(`unknown exit code: ${String(code)}`);
    }
    this.name = "AccError";
    this.code = code;
    this.details = details;
  }
}

export function isAccError(value) {
  return value instanceof AccError;
}
