// This focused file intentionally keeps the legacy, installed-product, and
// transport capture variants together so they exercise one canonical fixture
// and prove that the schemas cannot substitute for one another.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DELIVERY_CAPTURE_FIELDS,
  DELIVERY_CAPTURE_REQUIRED_FIELDS,
  DELIVERY_LAUNCH_MODES,
  INSTALLED_HOOKS_LAUNCH_MODE,
  PASSING_DELIVERY_BRANCHES,
  PASSING_LAUNCH_MODE,
  TRANSPORT_CAPTURE_FIELDS,
  TRANSPORT_PASSING_FACTS,
  validateCapture,
  validateTransportCapture,
} from "../../scripts/spikes/delivery-capture.mjs";
import { matrixEvidence } from "../helpers/codex-local-daemon-evidence.mjs";
import { validateCapture as legacyValidateCapture }
  from "../../scripts/spikes/json-rpc-peer.mjs";

const BASE_CAPTURE = {
  client: "fixture-client",
  version: "1.0.0",
  platform: "darwin-arm64",
  observedAt: "2026-09-02T12:00:00.000Z",
  capability: "native_delivery",
  result: "fail",
  fixture: "fixture-client-1.0.0",
  launchMode: "ordinary-command-with-install-time-bootstrap",
  protocolContract: "fixture-protocol-v1",
  idle: "unobserved",
  busy: "unobserved",
  reply: "unobserved",
  duplicate: "unobserved",
  fallback: "unobserved",
  limitations: ["fixture only"],
};

const PASSING_CAPTURE = {
  ...BASE_CAPTURE,
  result: "pass",
  idle: "offered",
  busy: "queued_after_turn",
  reply: "routed",
  duplicate: "same_message_id",
  fallback: "queued",
};

const BRANCHES = ["idle", "busy", "reply", "duplicate", "fallback"];
const LIMITATIONS_ERROR = /capture limitations is a non-empty array of non-empty strings/;

function rejects(capture, pattern) {
  assert.throws(() => validateCapture(capture), pattern);
}

function accepts(capture) {
  assert.doesNotThrow(() => validateCapture(capture));
}

test("a passing native capture names every observed branch", () => {
  assert.deepEqual(validateCapture(PASSING_CAPTURE), PASSING_CAPTURE);
});

test("the capture vocabulary is frozen and closed", () => {
  assert.equal(Object.isFrozen(DELIVERY_CAPTURE_FIELDS), true);
  assert.equal(Object.isFrozen(DELIVERY_LAUNCH_MODES), true);
  assert.equal(Object.isFrozen(PASSING_DELIVERY_BRANCHES), true);
  assert.deepEqual(Object.keys(PASSING_DELIVERY_BRANCHES), BRANCHES);
  for (const branch of BRANCHES) {
    assert.equal(Object.isFrozen(PASSING_DELIVERY_BRANCHES[branch]), true);
  }
  assert.deepEqual([...DELIVERY_CAPTURE_REQUIRED_FIELDS], Object.keys(BASE_CAPTURE));
  assert.deepEqual([...DELIVERY_CAPTURE_FIELDS], [...Object.keys(BASE_CAPTURE), "packageSha256"]);
});

test("a capture includes every redacted evidence field", () => {
  for (const key of DELIVERY_CAPTURE_REQUIRED_FIELDS) {
    const capture = { ...PASSING_CAPTURE };
    delete capture[key];
    rejects(capture, new RegExp(`capture requires ${key}`));
  }
});

test("a capture rejects unknown fields and non-objects", () => {
  const unknown = [["transcript", "hidden"], ["notes", []], ["busyBehavior", "offered"]];
  for (const [key, value] of unknown) {
    rejects({ ...PASSING_CAPTURE, [key]: value },
      new RegExp(`capture has unknown field ${key}`));
  }
  for (const value of [null, undefined, "capture", 1, [PASSING_CAPTURE]]) {
    rejects(value, /capture is an object/);
  }
});

test("capture client and fixture are stable identifiers", () => {
  for (const client of ["", " ", "Claude Code", "claude_code", "-claude", 7, null]) {
    rejects({ ...PASSING_CAPTURE, client }, /capture client is a stable identifier/);
  }
  for (const fixture of ["", "Fixture 1", "client/1.0.0", null]) {
    rejects({ ...PASSING_CAPTURE, fixture }, /capture fixture is a stable identifier/);
  }
  accepts({ ...PASSING_CAPTURE, client: "codex-cli", fixture: "codex-cli-0.152.1" });
});

test("capture version is an exact stable semantic version", () => {
  for (const version of ["2.1.258", "0.152.1", "10.0.0", "1.0.0"]) {
    accepts({ ...PASSING_CAPTURE, version });
  }
  const invalid = ["1.0", "v1.0.0", "01.0.0", "1.0.0-beta.1", "1.0.0+build.1", "1.0.0.1", "", 1];
  for (const version of invalid) {
    rejects({ ...PASSING_CAPTURE, version }, /capture version is a stable semantic version/);
  }
});

test("capture platform is a captured platform id", () => {
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]) {
    accepts({ ...PASSING_CAPTURE, platform });
  }
  for (const platform of ["darwin", "macos-arm64", "linux-arm", "win32-arm64", "", null]) {
    rejects({ ...PASSING_CAPTURE, platform }, /capture platform is one of darwin-arm64/);
  }
});

test("capture observedAt is a UTC timestamp", () => {
  for (const observedAt of ["2026-09-02T12:00:00Z", "2026-09-02T12:00:00.000Z"]) {
    accepts({ ...PASSING_CAPTURE, observedAt });
  }
  const invalid = ["2026-09-02", "2026-09-02T12:00:00+02:00", "2026-13-40T00:00:00Z",
    "yesterday", "", 0];
  for (const observedAt of invalid) {
    rejects({ ...PASSING_CAPTURE, observedAt }, /capture observedAt is a UTC timestamp/);
  }
});

test("capture capability and result are closed", () => {
  for (const capability of ["claude_channel_native_delivery", "", "delivery.livePush"]) {
    rejects({ ...PASSING_CAPTURE, capability }, /capture capability is native_delivery/);
  }
  for (const result of ["unknown", "partial", "", true]) {
    rejects({ ...BASE_CAPTURE, result }, /capture result is pass or fail/);
  }
});

test("legacy bootstrap passes remain valid while installed hooks require product evidence", () => {
  assert.equal(PASSING_LAUNCH_MODE, "ordinary-command-with-install-time-bootstrap");
  assert.equal(INSTALLED_HOOKS_LAUNCH_MODE, "ordinary-command-with-installed-hooks");
  for (const launchMode of DELIVERY_LAUNCH_MODES) {
    if (launchMode === INSTALLED_HOOKS_LAUNCH_MODE) {
      accepts({ ...BASE_CAPTURE, client: "codex-cli", launchMode,
        packageSha256: "a".repeat(64) });
    } else accepts({ ...BASE_CAPTURE, launchMode });
    if (launchMode === PASSING_LAUNCH_MODE) accepts({ ...PASSING_CAPTURE, launchMode });
  }
  const installed = { ...PASSING_CAPTURE, client: "codex-cli", version: "0.152.1",
    launchMode: INSTALLED_HOOKS_LAUNCH_MODE, packageSha256: "a".repeat(64) };
  assert.throws(() => validateCapture(installed), /installed-hook pass requires product evidence/);
  assert.doesNotThrow(() => validateCapture(installed, { productEvidence: matrixEvidence() }));
  const noPackage = { ...installed };
  delete noPackage.packageSha256;
  assert.throws(() => validateCapture(noPackage, { productEvidence: matrixEvidence() }),
    /installed-hook capture requires packageSha256/);
  assert.throws(() => validateCapture({ ...installed, client: "claude-code" },
    { productEvidence: matrixEvidence() }), /installed-hook capture client is codex-cli/);
  assert.throws(() => validateCapture({ ...installed, packageSha256: "b".repeat(64) },
    { productEvidence: matrixEvidence() }), /package SHA-256 matches product evidence/);
  assert.throws(() => validateCapture(installed, { productEvidence: matrixEvidence("transport") }),
    /installed-hook pass requires product-phase evidence/);
  assert.throws(() => validateCapture(installed, {
    productEvidence: { ...matrixEvidence(), source: "synthetic-unit-fixture",
      scenarios: matrixEvidence().scenarios.map(item =>
        ({ ...item, source: "synthetic-unit-fixture" })) } }), /real-client product evidence/);
  for (const launchMode of ["acc-run-wrapper", "", "ordinary", null]) {
    rejects({ ...BASE_CAPTURE, launchMode }, /capture launchMode is one of/);
  }
});

test("transport captures use a separate closed schema and prove all four live-push facts", () => {
  const transport = { schemaVersion: 1, client: "codex-cli", version: "0.152.1",
    platform: "darwin-arm64", observedAt: "2026-09-08T12:00:00.000Z",
    capability: "native_delivery_transport", result: "pass", fixture: "codex-cli-0.152.1-transport",
    phase: "transport", packageSha256: "b".repeat(64),
    protocolContract: "codex-app-server-thread-queue-v1",
    exactBinding: "receiver_thread_matched", idle: "queue_add_accepted",
    busy: "queued_while_active", rejectedSubmission: "observed",
    durableReceipt: "queued", limitations: ["unit fixture"] };
  assert.deepEqual(validateTransportCapture(transport), transport);
  assert.deepEqual([...TRANSPORT_CAPTURE_FIELDS], Object.keys(transport));
  assert.deepEqual(TRANSPORT_PASSING_FACTS, { exactBinding: "receiver_thread_matched",
    idle: "queue_add_accepted", busy: "queued_while_active", rejectedSubmission: "observed",
    durableReceipt: "queued" });
  for (const key of Object.keys(TRANSPORT_PASSING_FACTS)) {
    assert.throws(() => validateTransportCapture({ ...transport, [key]: "unobserved" }),
      new RegExp(`passing transport capture proves ${key}`));
  }
  assert.throws(() => validateTransportCapture({ ...transport, body: "secret" }),
    /transport capture has unknown field body/);
  assert.throws(() => validateCapture(transport), /capture has unknown field schemaVersion/);
});

test("a capture names a closed protocol contract identifier", () => {
  for (const protocolContract of ["claude-code-channel-mcp-v1", "codex-app-server-thread-queue-v1"]) {
    accepts({ ...PASSING_CAPTURE, protocolContract });
  }
  for (const protocolContract of ["", " ", "Claude Channel v1", "claude_channel", "-v1", null]) {
    rejects({ ...BASE_CAPTURE, protocolContract },
      /capture protocolContract is a closed identifier/);
    rejects({ ...PASSING_CAPTURE, protocolContract },
      /capture protocolContract is a closed identifier/);
  }
});

test("an idle pass proves a native offer", () => {
  rejects({ ...PASSING_CAPTURE, idle: "unobserved" },
    /a passing capture proves idle behavior: offered/);
});

test("a busy pass proves delivery after the current turn or an honest busy rejection", () => {
  assert.deepEqual([...PASSING_DELIVERY_BRANCHES.busy], ["queued_after_turn", "rejected_busy"]);
  for (const busy of PASSING_DELIVERY_BRANCHES.busy) accepts({ ...PASSING_CAPTURE, busy });
  const vocabulary = /capture busy is queued_after_turn, rejected_busy or unobserved/;
  rejects({ ...PASSING_CAPTURE, busy: "not_interrupted" }, vocabulary);
  rejects({ ...BASE_CAPTURE, busy: "not_interrupted" }, vocabulary);
  rejects({ ...PASSING_CAPTURE, busy: "unobserved" },
    /a passing capture proves busy behavior: queued_after_turn or rejected_busy/);
});

test("a reply pass proves an explicit ACC reply route", () => {
  rejects({ ...PASSING_CAPTURE, reply: "unobserved" },
    /a passing capture proves reply behavior: routed/);
  for (const reply of ["inferred_from_transcript", "answered", "text_seen"]) {
    rejects({ ...BASE_CAPTURE, reply }, /capture reply is routed or unobserved/);
  }
});

test("a duplicate pass proves one logical message id", () => {
  rejects({ ...PASSING_CAPTURE, duplicate: "unobserved" },
    /a passing capture proves duplicate behavior: same_message_id/);
  rejects({ ...BASE_CAPTURE, duplicate: "second_notification" },
    /capture duplicate is same_message_id or unobserved/);
});

test("a fallback pass proves a queued receipt after a forced transport failure", () => {
  rejects({ ...PASSING_CAPTURE, fallback: "unobserved" },
    /a passing capture proves fallback behavior: queued/);
  rejects({ ...BASE_CAPTURE, fallback: "delivered" }, /capture fallback is queued or unobserved/);
});

test("capture branches are observed states or explicitly unobserved", () => {
  for (const branch of BRANCHES) {
    accepts({ ...BASE_CAPTURE, [branch]: PASSING_DELIVERY_BRANCHES[branch][0] });
    for (const value of [null, "unknown", "", true]) {
      rejects({ ...BASE_CAPTURE, [branch]: value }, new RegExp(`capture ${branch} is `));
    }
  }
});

test("a failed capture may leave branches unobserved but must carry a limitation", () => {
  accepts(BASE_CAPTURE);
  for (const limitations of [null, [], [""], ["   "], "fixture only", [1]]) {
    rejects({ ...BASE_CAPTURE, limitations }, LIMITATIONS_ERROR);
    rejects({ ...PASSING_CAPTURE, limitations }, LIMITATIONS_ERROR);
  }
});

test("the validated capture is a frozen clone", () => {
  const input = { ...PASSING_CAPTURE, limitations: ["darwin-arm64 only"] };
  const capture = validateCapture(input);
  input.limitations.push("mutated later");
  input.result = "fail";
  assert.deepEqual(capture, { ...PASSING_CAPTURE, limitations: ["darwin-arm64 only"] });
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(Object.isFrozen(capture.limitations), true);
});

test("the JSON-RPC helper re-exports the same validator for older spike callers", () => {
  assert.equal(legacyValidateCapture, validateCapture);
});

test("stored real-client captures satisfy the closed contract", () => {
  const stored = [
    ["../../packages/adapter-codex/fixtures/delivery/codex-cli-0.152.0.json", "fail"],
    ["../../packages/adapter-codex/fixtures/delivery/codex-cli-0.152.1.json", "pass"],
    ["../../packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.252.json", "fail"],
    ["../../packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.258.json", "pass"],
    ["../../packages/adapter-grok/fixtures/delivery/grok-1.0.13.json", "fail"],
  ];

  for (const [relative, result] of stored) {
    const fixtureUrl = new URL(relative, import.meta.url);
    const capture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
    assert.deepEqual(validateCapture(capture), capture, fileURLToPath(fixtureUrl));
    assert.equal(capture.result, result, fileURLToPath(fixtureUrl));
  }
});
