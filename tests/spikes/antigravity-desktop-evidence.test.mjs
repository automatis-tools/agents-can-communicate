import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_PRODUCT_CASES, assertAntigravityDesktopRunEvidence, observationsFrom, scenarioPasses }
  from "../../scripts/e2e/antigravity-desktop-evidence.mjs";

const AT = "2026-10-05T04:00:00.000Z";
const step = (overrides) => JSON.stringify({ step_index: 0, created_at: "2026-10-05T04:00:01Z", ...overrides });
const live = { data: { delivery: [{ outcome: "offered", transport: "live-adapter" }] } };

test("an idle wake is read from ACC's result and the conversation's transcript", () => {
  const transcript = [
    step({ source: "MODEL", type: "PLANNER_RESPONSE" }),
    step({ source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "[Message] ... content=ACC peer message message_a (question) from p: ..." }),
    step({ source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-10-05T04:00:02Z" }),
  ].join("\n");
  const observations = observationsFrom({ caseId: "D01", delivery: live, transcript, messageId: "message_a", at: AT });

  assert.equal(scenarioPasses("D01", observations), true);
  assert.deepEqual(observations.map(item => `${item.kind}=${item.outcome}`),
    ["delivery=offered", "desktop-push=pushed", "model-turn=started-without-user-input"]);
});

test("a wake the user had to prompt is no idle wake", () => {
  const transcript = [
    step({ source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "ACC peer message message_a (question)" }),
    step({ source: "USER_EXPLICIT", type: "USER_INPUT" }),
    step({ source: "MODEL", type: "PLANNER_RESPONSE" }),
  ].join("\n");
  const observations = observationsFrom({ caseId: "D01", delivery: live, transcript, messageId: "message_a", at: AT });
  assert.equal(scenarioPasses("D01", observations), false);
});

test("a message shown twice fails the duplicate case, and an unattended reply needs no approval", () => {
  const twice = [1, 2].map(() => step({ source: "SYSTEM", type: "SYSTEM_MESSAGE",
    content: "ACC peer message message_d (request)" })).join("\n");
  assert.equal(scenarioPasses("D04", observationsFrom({ caseId: "D04", transcript: twice, messageId: "message_d",
    observed: [`logical-message=same-message-id@${AT}`], at: AT })), false);
  assert.equal(scenarioPasses("D03", [{ kind: "answer", outcome: "recorded", at: AT },
    { kind: "receipt", outcome: "acknowledged", at: AT }, { kind: "approval", outcome: "asked", at: AT }]), false);
});

test("a run needs every case, closed fields and matching counts", () => {
  const scenarios = Object.keys(DESKTOP_PRODUCT_CASES).map(caseId => ({ caseId, outcome: "failed",
    startedAt: AT, finishedAt: AT, messageId: "message_x", observations: [] }));
  const run = { schemaVersion: 1, source: "real-client-capture", client: "antigravity-desktop", phase: "product",
    clientVersion: "2.19.1", platform: "darwin-arm64", packageSha256: "a".repeat(64), startedAt: AT,
    finishedAt: AT, scenarioCount: 6, passedCount: 0, failedCount: 6,
    cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" },
    scenarios };
  assert.doesNotThrow(() => assertAntigravityDesktopRunEvidence(run));
  assert.throws(() => assertAntigravityDesktopRunEvidence({ ...run, client: "antigravity-cli" }), /antigravity-desktop/);
  assert.throws(() => assertAntigravityDesktopRunEvidence({ ...run, scenarios: scenarios.slice(1) }), /requires case D01/);
  assert.throws(() => assertAntigravityDesktopRunEvidence({ ...run, passedCount: 1 }), /counts match/);
});
