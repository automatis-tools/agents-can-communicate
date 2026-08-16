import assert from "node:assert/strict";
import test from "node:test";

import { CommsError, EXIT } from "../../../tools/agents/lib/errors.mjs";

test("exit codes are stable", () => {
  assert.deepEqual(EXIT, {
    OK: 0,
    USAGE: 2,
    TIMEOUT: 3,
    DATA: 4,
    CONFLICT: 5,
    REQUIRED: 6,
  });
  assert.equal(new CommsError("bad data", EXIT.DATA).exitCode, 4);
});

test("protocol errors retain structured details", () => {
  const details = { path: "inbox/broken.json" };
  const error = new CommsError("bad data", EXIT.DATA, details);

  assert.equal(error.name, "CommsError");
  assert.equal(error.message, "bad data");
  assert.equal(error.exitCode, EXIT.DATA);
  assert.equal(error.details, details);
});
