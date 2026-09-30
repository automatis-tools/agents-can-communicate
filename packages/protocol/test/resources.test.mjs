import assert from "node:assert/strict";
import test from "node:test";

import { assertMatchableResource, normaliseResource } from "../src/resources.mjs";

// A Windows agent writes paths with backslashes. The CLI and the guard convert
// theirs, but a claim taken over MCP reaches core as typed, and a claim stored
// as `file:src\a.mjs` was reported guarded while a write to src/a.mjs went
// through.
test("a backslash separates segments the way a slash does", () => {
  assert.equal(normaliseResource("file:src\\a.mjs"), "file:src/a.mjs");
  assert.equal(normaliseResource("file:.\\src\\lib\\..\\a.mjs"), "file:src/a.mjs");
  assert.equal(normaliseResource("file:src\\**"), "file:src/**");
});

test("a trailing backslash names a directory, and is refused like a trailing slash", () => {
  const refused = [];
  assertMatchableResource("file:src\\", message => refused.push(message));
  assert.equal(refused.length, 1);
});

test("other schemes keep their backslashes", () => {
  assert.equal(normaliseResource("branch:feature\\x"), "branch:feature\\x");
});
