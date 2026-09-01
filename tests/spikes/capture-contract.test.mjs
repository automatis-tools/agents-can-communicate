import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateCapture } from "../../scripts/spikes/json-rpc-peer.mjs";

const BASE_CAPTURE = {
  client: "fixture-client",
  version: "1.0.0",
  platform: "darwin-arm64",
  observedAt: "2026-09-01T12:00:00.000Z",
  capability: "native_delivery",
  result: "fail",
  fixture: "fixture-client-1.0.0",
  idle: "unobserved",
  busy: "unobserved",
  reply: "unobserved",
  duplicate: "unobserved",
  fallback: "unobserved",
  limitations: ["fixture only"],
};

test("a passing native capture names every observed branch", () => {
  assert.doesNotThrow(() =>
    validateCapture({
      ...BASE_CAPTURE,
      result: "pass",
      idle: "offered",
      busy: "not_interrupted",
      reply: "routed",
      duplicate: "same_message_id",
      fallback: "queued",
    }),
  );
});

test("a passing capture requires busy behavior", () => {
  assert.throws(
    () =>
      validateCapture({
        ...BASE_CAPTURE,
        result: "pass",
        idle: "offered",
        busy: "unknown",
        reply: "routed",
        duplicate: "same_message_id",
        fallback: "queued",
      }),
    /a passing capture requires busy behavior/,
  );
});

test("a capture includes every redacted evidence field", () => {
  for (const key of Object.keys(BASE_CAPTURE)) {
    const capture = { ...BASE_CAPTURE };
    delete capture[key];
    assert.throws(() => validateCapture(capture), new RegExp(`capture requires ${key}`));
  }
});

test("a capture result is closed to pass or fail", () => {
  assert.throws(
    () => validateCapture({ ...BASE_CAPTURE, result: "unknown" }),
    /capture result is pass or fail/,
  );
});

test("stored real-client captures satisfy the closed contract", () => {
  const fixtureUrls = [
    new URL("../../packages/adapter-codex/fixtures/delivery/codex-cli-0.152.0.json",
      import.meta.url),
    new URL("../../packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.252.json",
      import.meta.url),
  ];

  for (const fixtureUrl of fixtureUrls) {
    const capture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
    assert.deepEqual(validateCapture(capture), capture, fileURLToPath(fixtureUrl));
  }
});
