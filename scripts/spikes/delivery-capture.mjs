// Closed contract for redacted native-delivery captures.
//
// A capture is evidence taken from a real installed client, never a simulation.
// The validator rejects half-proofs: a `pass` must come from the user's ordinary
// vendor command started through ACC's install-time bootstrap, must name the
// exact protocol contract it exercised, and must carry one observed passing
// state for every branch. Installed-hook captures additionally require their
// complete installed-product matrix. A `fail` may leave branches `unobserved`, but must
// explain itself with at least one limitation. Prompts, answers, transcripts,
// paths, and secrets have no field here by design.

import { assertRunEvidence } from "../e2e/codex-local-daemon-evidence.mjs";

export const CAPTURE_CAPABILITY = "native_delivery";
export const UNOBSERVED = "unobserved";

export const DELIVERY_CAPTURE_REQUIRED_FIELDS = Object.freeze([
  "client", "version", "platform", "observedAt", "capability", "result", "fixture",
  "launchMode", "protocolContract", "idle", "busy", "reply", "duplicate", "fallback",
  "limitations",
]);
export const DELIVERY_CAPTURE_FIELDS = Object.freeze([
  ...DELIVERY_CAPTURE_REQUIRED_FIELDS, "packageSha256",
]);

export const DELIVERY_CAPTURE_PLATFORMS = Object.freeze([
  "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64",
]);

// How the vendor client was started. The two ordinary installed launch paths
// can pass. Historical bootstrap evidence remains valid; an installed-hook
// pass needs the associated real-client product evidence below. The final two
// values record how earlier failed captures were actually produced.
export const PASSING_LAUNCH_MODE = "ordinary-command-with-install-time-bootstrap";
export const INSTALLED_HOOKS_LAUNCH_MODE = "ordinary-command-with-installed-hooks";
export const DELIVERY_LAUNCH_MODES = Object.freeze([
  PASSING_LAUNCH_MODE,
  INSTALLED_HOOKS_LAUNCH_MODE,
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

export const TRANSPORT_CAPTURE_FIELDS = Object.freeze([
  "schemaVersion", "client", "version", "platform", "observedAt", "capability", "result",
  "fixture", "phase", "packageSha256", "protocolContract", "exactBinding", "idle", "busy",
  "rejectedSubmission", "durableReceipt", "limitations",
]);
export const TRANSPORT_PASSING_FACTS = Object.freeze({
  exactBinding: "receiver_thread_matched",
  idle: "queue_add_accepted",
  busy: "queued_while_active",
  rejectedSubmission: "observed",
  durableReceipt: "queued",
});
const TRANSPORT_FACTS = Object.freeze(Object.fromEntries(Object.entries(TRANSPORT_PASSING_FACTS)
  .map(([key, value]) => [key, Object.freeze([value, UNOBSERVED])])));
const SHA256 = /^[a-f0-9]{64}$/;

export function validateCapture(value, { productEvidence } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture is an object");
  }
  for (const key of Object.keys(value)) {
    if (!DELIVERY_CAPTURE_FIELDS.includes(key)) {
      throw new Error(`capture has unknown field ${key}`);
    }
  }
  for (const key of DELIVERY_CAPTURE_REQUIRED_FIELDS) {
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
  if (value.launchMode === INSTALLED_HOOKS_LAUNCH_MODE) {
    expect(value.client === "codex-cli", "installed-hook capture client is codex-cli");
    expect(matches(SHA256, value.packageSha256),
      "installed-hook capture requires packageSha256");
  }
  for (const [branch, passing] of Object.entries(PASSING_DELIVERY_BRANCHES)) {
    expect(passing.includes(value[branch]) || value[branch] === UNOBSERVED,
      `capture ${branch} is ${passing.join(", ")} or ${UNOBSERVED}`);
  }
  expect(Array.isArray(value.limitations) && value.limitations.length > 0
    && value.limitations.every((item) => typeof item === "string" && item.trim() !== ""),
  "capture limitations is a non-empty array of non-empty strings");

  if (value.result === "pass") {
    expect([PASSING_LAUNCH_MODE, INSTALLED_HOOKS_LAUNCH_MODE].includes(value.launchMode),
      "a passing capture uses an ordinary installed launch mode");
    for (const [branch, passing] of Object.entries(PASSING_DELIVERY_BRANCHES)) {
      expect(passing.includes(value[branch]),
        `a passing capture proves ${branch} behavior: ${passing.join(" or ")}`);
    }
    if (value.launchMode === INSTALLED_HOOKS_LAUNCH_MODE) {
      expect(productEvidence !== undefined, "installed-hook pass requires product evidence");
      const evidence = assertRunEvidence(productEvidence);
      expect(evidence.phase === "product", "installed-hook pass requires product-phase evidence");
      expect(evidence.source === "real-client-capture",
        "installed-hook pass requires real-client product evidence");
      expect(evidence.failedCount === 0, "installed-hook pass requires every product case to pass");
      expect(evidence.clientVersion === value.version,
        "installed-hook pass client version matches product evidence");
      expect(evidence.platform === value.platform,
        "installed-hook pass platform matches product evidence");
      expect(evidence.client === value.client,
        "installed-hook pass client matches product evidence");
      expect(evidence.packageSha256 === value.packageSha256,
        "installed-hook pass package SHA-256 matches product evidence");
    }
  }

  const capture = {};
  for (const key of DELIVERY_CAPTURE_FIELDS) {
    if (Object.hasOwn(value, key)) capture[key] = value[key];
  }
  capture.limitations = Object.freeze([...value.limitations]);
  return Object.freeze(capture);
}

export function validateTransportCapture(value) {
  expect(value && typeof value === "object" && !Array.isArray(value),
    "transport capture is an object");
  for (const key of Object.keys(value)) {
    expect(TRANSPORT_CAPTURE_FIELDS.includes(key), `transport capture has unknown field ${key}`);
  }
  for (const key of TRANSPORT_CAPTURE_FIELDS) {
    expect(Object.hasOwn(value, key), `transport capture requires ${key}`);
  }
  expect(value.schemaVersion === 1, "transport capture schemaVersion is 1");
  expect(matches(IDENTIFIER, value.client), "transport capture client is a stable identifier");
  expect(matches(STABLE_VERSION, value.version), "transport capture version is exact semver");
  expect(DELIVERY_CAPTURE_PLATFORMS.includes(value.platform),
    "transport capture platform is captured");
  expect(matches(UTC_TIMESTAMP, value.observedAt) && !Number.isNaN(Date.parse(value.observedAt)),
    "transport capture observedAt is a UTC timestamp");
  expect(value.capability === "native_delivery_transport",
    "transport capture capability is native_delivery_transport");
  expect(RESULTS.includes(value.result), "transport capture result is pass or fail");
  expect(matches(FIXTURE_ID, value.fixture), "transport capture fixture is a stable identifier");
  expect(value.phase === "transport", "transport capture phase is transport");
  expect(matches(SHA256, value.packageSha256), "transport capture packageSha256 is lowercase SHA-256");
  expect(matches(IDENTIFIER, value.protocolContract),
    "transport capture protocolContract is a closed identifier");
  for (const [key, values] of Object.entries(TRANSPORT_FACTS)) {
    expect(values.includes(value[key]), `transport capture ${key} is ${values.join(" or ")}`);
    if (value.result === "pass") expect(value[key] === TRANSPORT_PASSING_FACTS[key],
      `passing transport capture proves ${key}`);
  }
  expect(Array.isArray(value.limitations) && value.limitations.length > 0
    && value.limitations.every(item => typeof item === "string" && item.trim() !== ""),
  "transport capture limitations is a non-empty array of non-empty strings");
  const capture = {};
  for (const key of TRANSPORT_CAPTURE_FIELDS) capture[key] = value[key];
  capture.limitations = Object.freeze([...value.limitations]);
  return Object.freeze(capture);
}

function matches(pattern, candidate) {
  return typeof candidate === "string" && pattern.test(candidate);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}
