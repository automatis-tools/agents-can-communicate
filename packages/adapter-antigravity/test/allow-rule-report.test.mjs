import assert from "node:assert/strict";
import path from "node:path";
import nodeTest from "node:test";

import { detectAntigravity, doctorAntigravity, installAntigravity,
  planAntigravityInstall } from "../src/install.mjs";
import { agyHome } from "./agy-home.mjs";
import { NO_ALLOW_RULE_ON_WINDOWS } from "../../../tests/helpers/platform-scope.mjs";

const test = (name, ...rest) => { const fn = rest.pop(); const options = rest[0] ?? {};
  return nodeTest(name, { ...options, skip: options.skip ?? NO_ALLOW_RULE_ON_WINDOWS }, fn); };

/**
 * What ACC says about the approval prompt, before and after the rule exists.
 *
 * Doctor is where an operator finds out why a woken session never answered, so
 * each state is named with the file and the rule that decide it: present,
 * absent, or unable to apply on this machine. Captured on 1.2.12 (issue #214):
 * a command whose first word was quoted never matched any rule, so a wrapper
 * path that needs quotes cannot be allowed by a rule at all.
 */

test("a missing rule is ACC's install undone, and doctor says how to put it back", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);

  const detected = await detectAntigravity(fixture.context);
  const doctor = await doctorAntigravity(fixture.context);

  assert.equal(detected.commandApproval.state, "prompts");
  assert.equal(detected.commandApproval.rule, fixture.rule);
  assert.equal(detected.commandApproval.file, fixture.settings);
  assert.equal(Object.hasOwn(detected.commandApproval, "setup"), false,
    "nothing asks the operator about the rule any more");
  for (const line of [detected.inboundDelivery.diagnostic,
    doctor.diagnostics.find(item => item.includes(fixture.rule))]) {
    assert.equal(typeof line, "string", "doctor never names the rule");
    assert.match(line, /live wake stops at/);
    assert.match(line, /approval prompt/);
    assert.equal(line.includes(fixture.settings), true, line);
    assert.equal(line.includes("permissions.allow"), true, line);
    // ACC always writes the rule, so the remedy is the install that writes it.
    assert.match(line, /acc install --adapter antigravity\b/);
    assert.doesNotMatch(line, /--delivery|consent/);
  }
});

test("doctor asks for a reinstall when ACC's rule is gone, whatever the delivery", async t => {
  // Always on: a missing rule is an install that did not finish here, so it
  // goes where doctor prints what to run next, not only into the inbound line
  // doctor shows for a client with live delivery on.
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  const notInstalled = await detectAntigravity(fixture.context);
  await installAntigravity(fixture.context);
  await fixture.write(fixture.theirs);

  const detected = await detectAntigravity(fixture.context);

  assert.equal((notInstalled.needsAction ?? []).some(line => line.includes(fixture.rule)), false,
    "ACC is not installed here, and doctor already says to install it");
  assert.equal(detected.needsAction?.some(line =>
    /^acc install --adapter antigravity\b/.test(line) && line.includes(fixture.rule)), true);
  await fixture.write("{ broken");
  const unreadable = await detectAntigravity(fixture.context);
  assert.equal(unreadable.needsAction?.some(line => line.includes(fixture.settings)), true);
});

test("detect reports a rule ACC added as present, and as ACC's", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  await installAntigravity(fixture.context);

  const detected = await detectAntigravity(fixture.context);

  assert.equal(detected.commandApproval.state, "allowed");
  assert.equal(detected.commandApproval.owned, true);
  assert.match(detected.inboundDelivery.diagnostic, /without an approval prompt/);
  assert.match(detected.inboundDelivery.diagnostic, /added by ACC/);
  assert.doesNotMatch(detected.inboundDelivery.diagnostic, /consent/);
});

test("doctor reads the rule from the data home the installer used", async t => {
  // `acc doctor` hands detection the state root, not the data home.
  const fixture = await agyHome(t);
  await installAntigravity(fixture.context);
  const { dataHome, ...rest } = fixture.context;

  const detected = await detectAntigravity({ ...rest, stateRoot: path.join(dataHome, "acc") });

  assert.equal(detected.commandApproval.owned, true);
});

test("an operator's own rule is present and is not called ACC's", async t => {
  const fixture = await agyHome(t);
  await fixture.write({ permissions: { allow: [`command("${fixture.wrapper}")`] } });

  const detected = await detectAntigravity(fixture.context);

  assert.equal(detected.commandApproval.state, "allowed");
  assert.equal(detected.commandApproval.owned, false);
  assert.doesNotMatch(detected.inboundDelivery.diagnostic, /added by ACC/);
});

test("a settings file ACC cannot read is reported, not guessed at", async t => {
  const fixture = await agyHome(t);
  await fixture.write("{ nope");

  const detected = await detectAntigravity(fixture.context);

  assert.equal(detected.commandApproval.state, "unreadable");
  assert.equal(detected.inboundDelivery.diagnostic.includes(fixture.settings), true);
});

test("a wrapper path that needs quotes gets no rule, and doctor says why", async t => {
  const fixture = await agyHome(t, { name: "acc agy home " });
  await fixture.write(fixture.theirs);
  const before = await fixture.read();

  const result = await installAntigravity(fixture.context);
  const detected = await detectAntigravity(fixture.context);

  assert.equal(await fixture.read(), before, "a rule that cannot match was written");
  assert.equal(detected.commandApproval.state, "unmatchable");
  const why = detected.inboundDelivery.diagnostic;
  assert.match(why, /quote/);
  assert.match(why, /first word/);
  assert.match(why, /live wake stops at/);
  assert.equal(why.includes(fixture.wrapper), true);
  assert.equal(result.needsAction?.includes(why), true,
    "install was asked for the rule and did not say it could not add it");
});

test("the plan names the settings file whenever a rule can be written", async t => {
  const fixture = await agyHome(t);
  const quoted = await agyHome(t, { name: "acc agy plan " });

  const plan = planAntigravityInstall(fixture.context);
  const unsafe = planAntigravityInstall(quoted.context);

  const artifact = plan.find(item => item.path === fixture.settings);
  assert.ok(artifact, "install edits the settings file and the plan does not say so");
  // Edited in place and taken back by the adapter, never deleted by the installer.
  assert.equal(artifact.kind, "merge");
  assert.equal(unsafe.some(item => item.path === quoted.settings), false,
    "the plan promises an edit that a quoted wrapper path never gets");
});

nodeTest("windows: no rule is written, and doctor says why and what that costs", async () => {
  const { inspectAllowRule } = await import("../src/allow-rule.mjs");
  const report = await inspectAllowRule({ home: "C:\\Users\\Ann", hostPlatform: "win32" });
  assert.equal(report.state, "unmatchable");
  assert.equal(report.wrapper.endsWith("acc-cli.mjs"), true, report.wrapper);
  assert.match(report.diagnostic, /Windows/);
  assert.match(report.diagnostic, /node/);
});
