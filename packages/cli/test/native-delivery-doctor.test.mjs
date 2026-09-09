import assert from "node:assert/strict";
import test from "node:test";

import { describeNative } from "../src/doctor-command.mjs";
import { updateNativeRuntime } from "../src/native-delivery-status.mjs";

// The closed native-delivery state model doctor reports, exercised directly so
// every combination is held to one shape without a client on the machine.
const state = overrides => ({ eligibility: "eligible", configured: false, policy: "off",
  runtime: "inactive", modes: [], reasonCode: null, ...overrides });

test("eligibility, configuration, policy, and runtime are reported as distinct facts", () => {
  assert.equal(describeNative(state()), "available; off");
  assert.equal(describeNative(state({ configured: true, policy: "actionable", runtime: "waiting" })),
    "available; enabled (actionable); no live channel bound in this workspace");
  assert.equal(describeNative(state({ configured: true, policy: "all", runtime: "active",
    modes: ["livePush", "replyRoute"] })), "available; enabled (all); active");
});

test("an unsupported or degraded client names its closed reason and never claims a session", () => {
  assert.equal(describeNative(state({ eligibility: "unsupported",
    reasonCode: "below_minimum_version" })), "unavailable: the client is below the native delivery minimum version; off");
  assert.equal(describeNative(state({ eligibility: "unsupported",
    reasonCode: "native_delivery_unsupported" })), "unavailable: this adapter has no native delivery channel; off");
  assert.equal(describeNative(state({ eligibility: "degraded", configured: true,
    policy: "actionable", runtime: "degraded", reasonCode: "unsupported_shell" })),
  "readiness unverified: automatic launch setup requires zsh; enabled (actionable); channel unreachable");
  assert.equal(describeNative(state({ eligibility: "eligible", configured: true,
    policy: "actionable", runtime: "active" })).includes("read"), false,
  "the line must never suggest a model read the message");
});


test("native runtime ignores next-turn bindings and separates installed from running consent", () => {
  const entry = (policySource, policy = "actionable") => ({ adapterId: "fixture",
    nativeDelivery: state({ configured: policy !== "off", policy, policySource, runtime: "waiting" }) });
  const binding = { adapterId: "fixture", reachable: true,
    availableModes: ["nextTurn"], livePolicy: "actionable" };
  const recipient = entry("installation-record");
  updateNativeRuntime([recipient], [binding]);
  assert.equal(recipient.nativeDelivery.runtime, "waiting",
    "a hook-only binding was advertised as an active native channel");
  const live = { ...binding, availableModes: ["livePush", "idleWake"] };
  updateNativeRuntime([recipient], [live]);
  assert.equal(recipient.nativeDelivery.runtime, "active");
  assert.equal(recipient.nativeDelivery.sessionPolicy, "actionable");

  for (const [installed, bound] of [["actionable", "all"], ["all", "actionable"]]) {
    const changed = entry("installation-record", installed);
    updateNativeRuntime([changed], [{ ...live, livePolicy: bound }]);
    assert.equal(changed.nativeDelivery.sessionPolicy, installed,
      "stored consent applies to every new offer, including existing sessions");
    assert.doesNotMatch(describeNative(changed.nativeDelivery), /for new sessions/);
  }
  const disabled = entry("installation-record", "off");
  updateNativeRuntime([disabled], [live]);
  assert.equal(disabled.nativeDelivery.runtime, "inactive",
    "the recorded policy blocks native offers even while an old binding remains");
  const running = entry("bootstrap-environment", "off");
  updateNativeRuntime([running], [live]);
  assert.equal(running.nativeDelivery.runtime, "active");
  assert.match(describeNative(running.nativeDelivery), /off for new sessions/);
  assert.match(describeNative(running.nativeDelivery), /active.*session policy: actionable/);
});
