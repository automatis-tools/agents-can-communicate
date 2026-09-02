import assert from "node:assert/strict";
import test from "node:test";

import { describeNative } from "../src/doctor-command.mjs";

// The closed native-delivery state model doctor reports, exercised directly so
// every combination is held to one shape without a client on the machine.
const state = overrides => ({ eligibility: "eligible", configured: false, policy: "off",
  runtime: "inactive", modes: [], reasonCode: null, ...overrides });

test("eligibility, configuration, policy, and runtime are reported as distinct facts", () => {
  assert.equal(describeNative(state()), "eligible - eligible, not enabled - not enabled");
  assert.equal(describeNative(state({ configured: true, policy: "actionable", runtime: "waiting" })),
    "eligible - enabled (actionable) - waiting for a live session");
  assert.equal(describeNative(state({ configured: true, policy: "all", runtime: "active",
    modes: ["livePush", "replyRoute"] })), "eligible - enabled (all) - active");
});

test("an unsupported or degraded client names its closed reason and never claims a session", () => {
  assert.equal(describeNative(state({ eligibility: "unsupported",
    reasonCode: "below_minimum_version" })), "unsupported (below_minimum_version)");
  assert.equal(describeNative(state({ eligibility: "unsupported",
    reasonCode: "native_delivery_unsupported" })), "unsupported (native_delivery_unsupported)");
  assert.equal(describeNative(state({ eligibility: "degraded", configured: true,
    policy: "actionable", runtime: "degraded", reasonCode: "unsupported_shell" })),
  "degraded - enabled (actionable) - degraded - unsupported_shell");
  assert.equal(describeNative(state({ eligibility: "eligible", configured: true,
    policy: "actionable", runtime: "active" })).includes("read"), false,
  "the line must never suggest a model read the message");
});
