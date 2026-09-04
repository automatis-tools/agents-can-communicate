// Closed contract for redacted native-delivery captures.
//
// A capture is evidence taken from a real installed client, never a simulation.
// The validator rejects half-proofs: a `pass` must come from the user's ordinary
// vendor command started through ACC's install-time bootstrap, must name the
// exact protocol contract it exercised, and must carry one observed passing
// state for every branch. A `fail` may leave branches `unobserved`, but must
// explain itself with at least one limitation. Prompts, answers, transcripts,
// paths, and secrets have no field here by design.

export const CAPTURE_CAPABILITY = "native_delivery";
export const UNOBSERVED = "unobserved";

export const DELIVERY_CAPTURE_FIELDS = Object.freeze([
  "client", "version", "platform", "observedAt", "capability", "result", "fixture",
  "launchMode", "protocolContract", "idle", "busy", "reply", "duplicate", "fallback",
  "limitations",
]);

export const DELIVERY_CAPTURE_PLATFORMS = Object.freeze([
  "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64",
]);

// How the vendor client was started. Only the first value can pass: the user's
// own `claude`/`codex` command, with the install-time shell bootstrap doing the
// launch-time check and then `exec`-ing the vendor binary. The other two record
// how the earlier failed captures were actually produced.
export const PASSING_LAUNCH_MODE = "ordinary-command-with-install-time-bootstrap";
export const DELIVERY_LAUNCH_MODES = Object.freeze([
  PASSING_LAUNCH_MODE,
  "manual-vendor-invocation",
  "no-client-launched",
]);

// `busy` deliberately has no "the turn was not interrupted" value: a pass must
// show the queued message presented after the turn, or an explicit rejection.
export const PASSING_DELIVERY_BRANCHES = Object.freeze({
  idle: Object.freeze(["offered"]),
  busy: Object.freeze(["queued_after_turn", "rejected_busy"]),
  reply: Object.freeze(["routed"]),
  duplicate: Object.freeze(["same_message_id"]),
  fallback: Object.freeze(["queued"]),
});

const RESULTS = Object.freeze(["pass", "fail"]);
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIXTURE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function validateCapture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture is an object");
  }
  for (const key of Object.keys(value)) {
    if (!DELIVERY_CAPTURE_FIELDS.includes(key)) {
      throw new Error(`capture has unknown field ${key}`);
    }
  }
  for (const key of DELIVERY_CAPTURE_FIELDS) {
    if (!Object.hasOwn(value, key)) throw new Error(`capture requires ${key}`);
  }

  expect(matches(IDENTIFIER, value.client), "capture client is a stable identifier");
  expect(matches(STABLE_VERSION, value.version), "capture version is a stable semantic version");
  expect(DELIVERY_CAPTURE_PLATFORMS.includes(value.platform),
    `capture platform is one of ${DELIVERY_CAPTURE_PLATFORMS.join(", ")}`);
  expect(matches(UTC_TIMESTAMP, value.observedAt) && !Number.isNaN(Date.parse(value.observedAt)),
    "capture observedAt is a UTC timestamp");
  expect(value.capability === CAPTURE_CAPABILITY, `capture capability is ${CAPTURE_CAPABILITY}`);
  expect(RESULTS.includes(value.result), "capture result is pass or fail");
  expect(matches(FIXTURE_ID, value.fixture), "capture fixture is a stable identifier");
  expect(DELIVERY_LAUNCH_MODES.includes(value.launchMode),
    `capture launchMode is one of ${DELIVERY_LAUNCH_MODES.join(", ")}`);
  expect(matches(IDENTIFIER, value.protocolContract),
    "capture protocolContract is a closed identifier");
  for (const [branch, passing] of Object.entries(PASSING_DELIVERY_BRANCHES)) {
    expect(passing.includes(value[branch]) || value[branch] === UNOBSERVED,
      `capture ${branch} is ${passing.join(", ")} or ${UNOBSERVED}`);
  }
  expect(Array.isArray(value.limitations) && value.limitations.length > 0
    && value.limitations.every((item) => typeof item === "string" && item.trim() !== ""),
  "capture limitations is a non-empty array of non-empty strings");

  if (value.result === "pass") {
    expect(value.launchMode === PASSING_LAUNCH_MODE,
      "a passing capture launches the ordinary command through the install-time bootstrap");
    for (const [branch, passing] of Object.entries(PASSING_DELIVERY_BRANCHES)) {
      expect(passing.includes(value[branch]),
        `a passing capture proves ${branch} behavior: ${passing.join(" or ")}`);
    }
  }

  const capture = {};
  for (const key of DELIVERY_CAPTURE_FIELDS) capture[key] = value[key];
  capture.limitations = Object.freeze([...value.limitations]);
  return Object.freeze(capture);
}

function matches(pattern, candidate) {
  return typeof candidate === "string" && pattern.test(candidate);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}
