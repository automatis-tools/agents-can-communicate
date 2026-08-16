import assert from "node:assert/strict";
import test from "node:test";

import { assertPortableId, createId } from "../src/ids.mjs";
import { EXIT } from "../src/errors.mjs";

const sequential = length => Buffer.from(Array.from({ length }, (_, index) => index));

test("identifiers are kind-prefixed and URL-safe", () => {
  const id = createId("session", sequential);

  assert.match(id, /^session_[A-Za-z0-9_-]+$/);
  assert.equal(id.includes("/"), false);
  assert.equal(id.includes("+"), false);
  assert.equal(id.includes("="), false);
});

test("identifier generation is injected rather than ambient", () => {
  assert.equal(createId("task", sequential), createId("task", sequential));
  assert.notEqual(createId("task", () => Buffer.from([9, 9, 9])),
    createId("task", sequential));
});

test("a generated identifier is itself portable", () => {
  assert.equal(assertPortableId(createId("claim", sequential), "claim id").startsWith("claim_"),
    true);
});

test("the kind is validated before it reaches an identifier", () => {
  assert.throws(() => createId("../escape", sequential), error => error.code === EXIT.DATA);
  assert.throws(() => createId("", sequential), error => error.code === EXIT.DATA);
});

// Every rejection below is a real filesystem or protocol hazard: these
// identifiers become path segments and record filenames.
const REJECTED = [
  ["path separator", "session/child"],
  ["windows separator", "session\\child"],
  ["parent traversal", ".."],
  ["leading dot", ".hidden"],
  ["trailing dot", "session."],
  ["control character", "session\u0001id"],
  ["newline", "session\nid"],
  ["nul byte", "session\u0000id"],
  ["empty value", ""],
  ["whitespace", "session id"],
  ["colon", "session:id"],
  ["windows device", "CON"],
  ["windows device with suffix", "nul.json"],
  ["non-string", 42],
  ["null", null],
  ["over length", `s${"a".repeat(200)}`],
];

for (const [label, value] of REJECTED) {
  test(`assertPortableId rejects a ${label}`, () => {
    assert.throws(() => assertPortableId(value, "identifier"),
      error => error.code === EXIT.DATA && error.message.includes("identifier"));
  });
}

const ACCEPTED = ["a", "session_01", "task-7", "artifact.v2", "A1", "s".repeat(200)];

for (const value of ACCEPTED) {
  test(`assertPortableId accepts ${JSON.stringify(value)}`, () => {
    assert.equal(assertPortableId(value, "identifier"), value);
  });
}
