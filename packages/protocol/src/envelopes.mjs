import { AccError, EXIT } from "./errors.mjs";

// The CLI JSON envelope is versioned independently of the record schemas, so a
// client can recognise an envelope it cannot yet interpret (spec section 11).
export const ENVELOPE_VERSION = 1;

export function ok(data, meta = {}) {
  return Object.freeze({ envelope_version: ENVELOPE_VERSION, ok: true, data, meta });
}

export function failure(error) {
  // Stacks carry absolute paths and internal structure. An envelope is a
  // published artefact, so it gets the code, the human message, and the
  // structured details the thrower chose to expose - nothing else.
  const known = error instanceof AccError;
  return Object.freeze({
    envelope_version: ENVELOPE_VERSION,
    ok: false,
    error: {
      code: known ? error.code : EXIT.DATA,
      message: error?.message ?? String(error),
      details: known ? error.details : {},
    },
  });
}
