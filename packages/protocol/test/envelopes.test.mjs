import assert from "node:assert/strict";
import test from "node:test";

import { AccError, EXIT } from "../src/errors.mjs";
import { ENVELOPE_VERSION, failure, ok } from "../src/envelopes.mjs";

test("a success envelope is explicit about its version and payload", () => {
  const envelope = ok({ sessions: [] }, { cursor: "0000000042" });

  assert.deepEqual(envelope, {
    envelope_version: ENVELOPE_VERSION,
    ok: true,
    data: { sessions: [] },
    meta: { cursor: "0000000042" },
  });
});

test("meta defaults to an empty object", () => {
  assert.deepEqual(ok({ value: 1 }).meta, {});
});

test("a failure envelope carries a stable code, message, and details", () => {
  const envelope = failure(new AccError(EXIT.CONFLICT, "claim is held",
    { resource: "file:src/main.mjs" }));

  assert.deepEqual(envelope, {
    envelope_version: ENVELOPE_VERSION,
    ok: false,
    error: {
      code: EXIT.CONFLICT,
      message: "claim is held",
      details: { resource: "file:src/main.mjs" },
    },
  });
});

test("failure envelopes never leak a stack trace", () => {
  const error = new AccError(EXIT.DATA, "corrupt record", { path: "/tmp/x" });
  const serialised = JSON.stringify(failure(error));

  assert.equal(serialised.includes("stack"), false);
  assert.equal(serialised.includes(".mjs:"), false);
  assert.equal("stack" in failure(error).error, false);
});

test("an unexpected error becomes a generic failure without its stack", () => {
  const envelope = failure(new TypeError("cannot read properties of undefined"));

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, EXIT.DATA);
  assert.equal(envelope.error.message, "cannot read properties of undefined");
  assert.deepEqual(envelope.error.details, {});
  assert.equal("stack" in envelope.error, false);
});

test("envelopes serialise to exactly one JSON object", () => {
  const rendered = `${JSON.stringify(ok({ value: 1 }))}\n`;

  assert.equal(rendered.trimEnd().split("\n").length, 1);
  assert.deepEqual(JSON.parse(rendered), ok({ value: 1 }));
});

test("envelopes are frozen so a caller cannot mutate a published result", () => {
  const envelope = ok({ value: 1 });

  assert.equal(Object.isFrozen(envelope), true);
  assert.throws(() => { envelope.ok = false; }, TypeError);
});
