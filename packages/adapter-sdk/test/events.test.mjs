import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { NORMALIZED_EVENT_KEYS, normalizedEvent } from "../src/events.mjs";

const base = { kind: "beforeTool", sessionId: "s", cwd: "/workspace" };

test("every adapter produces the same key set", () => {
  const event = normalizedEvent(base);

  assert.deepEqual(Object.keys(event).sort(), [...NORMALIZED_EVENT_KEYS].sort());
  // Absent is null or empty, never missing: a consumer that has to test for the
  // presence of a key ends up guessing differently per adapter.
  assert.equal(event.model, null);
  assert.equal(event.tool, null);
  assert.deepEqual(event.targets, []);
});

test("targets carry the paths a call would write, and nothing else", () => {
  // A resource identifier, not conversation content. Without it a guard has
  // nothing to compare against a claim, and `guards.beforeWrite` is decorative.
  const event = normalizedEvent({ ...base, tool: "Write",
    targets: ["src/a.mjs", "src/b.mjs"] });

  assert.deepEqual(event.targets, ["src/a.mjs", "src/b.mjs"]);
});

test("an event carries the targets it was given and invents none", () => {
  // Reading a command for its write positions is the adapter's job; this shape
  // carries the result and adds nothing of its own.
  assert.deepEqual(normalizedEvent({ ...base, tool: "Bash" }).targets, []);
});

test("the event is frozen, targets included", () => {
  const event = normalizedEvent({ ...base, targets: ["a"] });

  assert.equal(Object.isFrozen(event), true);
  assert.throws(() => { event.targets.push("b"); }, TypeError);
});

test("a malformed event is refused rather than passed on", () => {
  assert.throws(() => normalizedEvent({ ...base, kind: "imaginary" }),
    error => error.code === EXIT.DATA);
  assert.throws(() => normalizedEvent({ kind: "beforeTool", cwd: "/workspace" }),
    error => error.code === EXIT.DATA);
  assert.throws(() => normalizedEvent({ ...base, targets: "src/a.mjs" }),
    error => error.code === EXIT.DATA && /targets/.test(error.message));
  assert.throws(() => normalizedEvent({ ...base, targets: [""] }),
    error => error.code === EXIT.DATA);
});

test("an unknown field is refused, so a per-adapter extra cannot drift in", () => {
  assert.throws(() => normalizedEvent({ ...base, transcriptPath: "/tmp/t.jsonl" }),
    error => error.code === EXIT.DATA && /transcriptPath/.test(error.message));
});
