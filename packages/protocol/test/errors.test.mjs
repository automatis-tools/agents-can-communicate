import assert from "node:assert/strict";
import test from "node:test";

import { AccError, EXIT } from "../src/errors.mjs";

test("exit codes are stable and keep the reconciled numeric slots", () => {
  assert.deepEqual(EXIT, {
    OK: 0,
    USAGE: 2,
    TIMEOUT: 3,
    DATA: 4,
    CONFLICT: 5,
    ATTENTION: 6,
  });
  // Slot 3 stays timeout and slot 6 keeps the meaning the prototype called
  // REQUIRED, so ported process tests retain their exit-code contract.
  assert.equal(EXIT.TIMEOUT, 3);
  assert.equal(EXIT.ATTENTION, 6);
});

test("the exit table is frozen against accidental extension", () => {
  assert.equal(Object.isFrozen(EXIT), true);
  assert.throws(() => { EXIT.DATA = 9; }, TypeError);
});

test("errors carry a numeric code and structured details", () => {
  const details = { path: "inbox/broken.json" };
  const error = new AccError(EXIT.DATA, "bad data", details);

  assert.equal(error instanceof Error, true);
  assert.equal(error.name, "AccError");
  assert.equal(error.message, "bad data");
  assert.equal(error.code, EXIT.DATA);
  assert.deepEqual(error.details, details);
});

test("details default to an empty object rather than null", () => {
  // Callers serialise details straight into JSON envelopes, so the absent case
  // must not force every consumer to null-check.
  assert.deepEqual(new AccError(EXIT.CONFLICT, "taken").details, {});
});

test("an unknown code is rejected at construction", () => {
  assert.throws(() => new AccError(99, "nope"), /unknown exit code/);
  assert.throws(() => new AccError(undefined, "nope"), /unknown exit code/);
});
