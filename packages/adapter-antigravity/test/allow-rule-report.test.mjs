import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { detectAntigravity, doctorAntigravity, installAntigravity,
  planAntigravityInstall } from "../src/install.mjs";
import { CONSENTED, agyHome } from "./agy-home.mjs";

/**
 * What ACC says about the approval prompt, before and after the rule exists.
 *
 * Doctor is where an operator finds out why a woken session never answered, so
 * each state is named with the file and the rule that decide it: present,
 * absent, or unable to apply on this machine. Captured on 1.2.12 (issue #214):
 * a command whose first word was quoted never matched any rule, so a wrapper
 * path that needs quotes cannot be allowed by a rule at all.
 */
const consented = fixture => ({ ...fixture.context, ...CONSENTED });

test("detect reports the rule as absent, and doctor says what that costs", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);

  const detected = await detectAntigravity(fixture.context);
  const doctor = await doctorAntigravity(fixture.context);

  assert.equal(detected.commandApproval.state, "prompts");
  assert.equal(detected.commandApproval.rule, fixture.rule);
  assert.equal(detected.commandApproval.file, fixture.settings);
  assert.equal(typeof detected.commandApproval.setup, "string");
  for (const line of [detected.inboundDelivery.diagnostic,
    doctor.diagnostics.find(item => item.includes(fixture.rule))]) {
    assert.equal(typeof line, "string", "doctor never names the rule");
    assert.match(line, /live wake stops at/);
    assert.match(line, /approval prompt/);
    assert.equal(line.includes(fixture.settings), true, line);
    assert.equal(line.includes("permissions.allow"), true, line);
  }
});

test("detect reports a rule ACC added as present, and as ACC's", async t => {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  await installAntigravity(consented(fixture));

  const detected = await detectAntigravity(fixture.context);

  assert.equal(detected.commandApproval.state, "allowed");
  assert.equal(detected.commandApproval.owned, true);
  assert.equal(detected.commandApproval.setup, null);
  assert.match(detected.inboundDelivery.diagnostic, /without an approval prompt/);
  assert.match(detected.inboundDelivery.diagnostic, /added by ACC/);
});

test("doctor reads the rule from the data home the installer used", async t => {
  // `acc doctor` hands detection the state root, not the data home.
  const fixture = await agyHome(t);
  await installAntigravity(consented(fixture));
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

  const result = await installAntigravity(consented(fixture));
  const detected = await detectAntigravity(fixture.context);

  assert.equal(await fixture.read(), before, "a rule that cannot match was written");
  assert.equal(detected.commandApproval.state, "unmatchable");
  assert.equal(detected.commandApproval.setup, null);
  const why = detected.inboundDelivery.diagnostic;
  assert.match(why, /quote/);
  assert.match(why, /first word/);
  assert.match(why, /live wake stops at/);
  assert.equal(why.includes(fixture.wrapper), true);
  assert.equal(result.needsAction?.includes(why), true,
    "install was asked for the rule and did not say it could not add it");
});

test("the plan names the settings file only when the rule is wanted", async t => {
  const fixture = await agyHome(t);

  const without = planAntigravityInstall(fixture.context);
  const withRule = planAntigravityInstall(consented(fixture));

  assert.equal(without.some(item => item.path === fixture.settings), false);
  const artifact = withRule.find(item => item.path === fixture.settings);
  assert.ok(artifact, "install edits the settings file and the plan does not say so");
  // Edited in place and taken back by the adapter, never deleted by the installer.
  assert.equal(artifact.kind, "merge");
});
