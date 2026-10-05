import { fakeAgy } from "../../packages/adapter-antigravity/test/fake-agy.mjs";
import { decideDelivery } from "../../packages/cli/src/install-command.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ALL_ADAPTERS, clientContext } from "@agents-can-communicate/cli";
import { applyPlan, detectInstallation, loadOwnership, planInstallation }
  from "@agents-can-communicate/installer";

import { NO_ALLOW_RULE_ON_WINDOWS } from "../helpers/platform-scope.mjs";

/**
 * Issue #214 through the whole install path: detection, the delivery decision,
 * the plan, the adapter's write, the record, a reinstall and an uninstall - the
 * real Antigravity adapter against a temporary home, with a stand-in agy.
 *
 * The user decided on 2026-09-27 that ACC always writes its allow rule when it
 * installs this adapter, with no question and whatever the delivery policy.
 * One run starts from the record 0.8.1 leaves for an operator who accepted live
 * delivery - the machine the capture was taken on - and one from nothing, with
 * delivery off and nobody at the terminal.
 *
 * `hostPlatform` names the platform whose form ACC writes; left out, it is this
 * host's.
 */
async function machine(t, hostPlatform, { operatorRelayRule = true } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-agy-e2e-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, "data");
  const settings = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  await mkdir(path.dirname(settings), { recursive: true });
  await mkdir(path.join(home, "project"), { recursive: true });
  const relay = `command(sh "${home}/.gemini/config/acc/acc-relay.sh" start)`;
  await writeFile(settings, `${JSON.stringify({ colorScheme: "dark",
    trustedWorkspaces: [path.join(home, "project")],
    permissions: { allow: operatorRelayRule ? [relay] : [] } }, null, 2)}\n`);
  const agy = fakeAgy();
  const context = { ...clientContext(home, path.join(dataHome, "acc"),
    { env: {}, dataHome, cwd: path.join(home, "project") }), runAgy: agy.run,
  ...(hostPlatform === undefined ? {} : { hostPlatform }),
  probeHooks: async () => ({ hooks: [{ name: "acc", enabled: true,
    actions: ["SessionStart", "PreInvocation", "Stop"].map(event => ({ event })) }] }) };
  const adapters = ALL_ADAPTERS().filter(adapter => adapter.id === "antigravity");
  // No agy on PATH: the version answer is the probe's, and no real binary runs.
  const detect = () => detectInstallation({ adapters, context, pathEnv: "",
    probe: async command => (command === "agy" ? "1.2.12" : null) });
  const run = async ({ action = "install", recorded, answers = [], interactive = true,
    options = {} }) => {
    const detected = await detect();
    const questions = [];
    const decided = action === "install" ? await decideDelivery({ options, detected,
      recorded, dryRun: false, runtime: { isInteractive: () => interactive,
        confirm: async question => { questions.push(question); return answers.shift(); } } })
      : { deliveryByAdapter: {}, deliveryDecisionByAdapter: {} };
    const plan = planInstallation({ adapters, detected, context, action, recorded,
      deliveryByAdapter: decided.deliveryByAdapter,
      deliveryDecisionByAdapter: decided.deliveryDecisionByAdapter });
    const result = await applyPlan({ plan, adapters, context, dataHome });
    assert.deepEqual(result.failed, []);
    return { questions, detected, result };
  };
  return { home, settings, dataHome, run, detect,
    rule: `command(${home}/.gemini/config/acc/acc-cli.sh)`, relay,
    read: () => readFile(settings, "utf8"),
    recorded: async () => (await loadOwnership({ dataHome })).installs };
}

const ON_0_8_1 = [{ adapterId: "antigravity", deliveryPolicy: "actionable",
  deliveryDecision: { source: "interactive-accepted", completeSetup: true } }];

test("reinstalling over 0.8.1 adds the rule once, asks nothing, and uninstall takes it back",
  { skip: NO_ALLOW_RULE_ON_WINDOWS }, async t => {
    const fixture = await machine(t);
    const before = await fixture.read();

    const first = await fixture.run({ recorded: ON_0_8_1 });
    assert.deepEqual(first.questions, []);
    const withRule = await fixture.read();
    assert.deepEqual(JSON.parse(withRule).permissions.allow,
      [...JSON.parse(before).permissions.allow, fixture.rule]);
    const [record] = await fixture.recorded();
    assert.deepEqual(record.deliveryDecision,
      { source: "interactive-accepted", completeSetup: true });
    assert.equal(record.artifacts.some(item => item.path === fixture.settings
      && item.kind === "merge"), true, "the record does not say ACC edits the settings file");
    const [after] = await fixture.detect();
    assert.equal(after.commandApproval.state, "allowed");
    assert.match(after.inboundDelivery.diagnostic, /added by ACC/);

    // Reinstall and automatic refresh: the same bytes, nobody asked.
    const second = await fixture.run({ recorded: await fixture.recorded() });
    assert.deepEqual(second.questions, []);
    assert.equal(await fixture.read(), withRule);

    await fixture.run({ action: "uninstall", recorded: await fixture.recorded() });
    assert.equal(await fixture.read(), before);
  });

test("delivery off and nobody at the terminal still get the rule",
  { skip: NO_ALLOW_RULE_ON_WINDOWS }, async t => {
  const fixture = await machine(t);
  const before = await fixture.read();

  const { questions } = await fixture.run({ recorded: [], interactive: false,
    options: { delivery: "off" } });

  assert.deepEqual(questions, []);
  assert.deepEqual(JSON.parse(await fixture.read()).permissions.allow,
    [...JSON.parse(before).permissions.allow, fixture.rule]);
  await fixture.run({ action: "uninstall", recorded: await fixture.recorded() });
  assert.equal(await fixture.read(), before);
});

// Windows writes no rule (a rule on `node` would allow every node command), so
// there the same two starts ask nothing and leave the user's settings byte for
// byte, through a reinstall and an uninstall. The Windows form is named outright,
// so every host checks it.
// The hook tells the agent to start its relay once per conversation, with the
// command `sh "<home>/.gemini/config/acc/acc-relay.sh" start`, and Antigravity CLI
// asks before running it. In a session nobody watches, the relay never starts
// and the session is never woken (e2e on Antigravity CLI 1.2.16, 2026-10-04).
// The rule in those exact words is the one the client itself persists when the
// operator picks "always allow"; ACC writes it beside the wrapper's, on every
// install, and takes back only what it added.
test("a fresh install also allows the command that starts live delivery, and uninstall takes it back",
  { skip: NO_ALLOW_RULE_ON_WINDOWS }, async t => {
    const fixture = await machine(t, undefined, { operatorRelayRule: false });
    const before = await fixture.read();

    const { questions } = await fixture.run({ recorded: [] });
    assert.deepEqual(questions, []);
    assert.deepEqual(JSON.parse(await fixture.read()).permissions.allow,
      [fixture.rule, fixture.relay]);
    const [after] = await fixture.detect();
    assert.equal(after.relayApproval.state, "allowed");
    assert.equal(after.relayApproval.owned, true);

    await fixture.run({ action: "uninstall", recorded: await fixture.recorded() });
    assert.equal(await fixture.read(), before);
  });

test("on Windows ACC adds no rule, asks nothing, and leaves the settings as it found them",
  async t => {
    const fixture = await machine(t, "win32");
    const before = await fixture.read();

    const first = await fixture.run({ recorded: ON_0_8_1 });
    assert.deepEqual(first.questions, []);
    assert.equal(await fixture.read(), before);
    const [record] = await fixture.recorded();
    assert.deepEqual(record.deliveryDecision,
      { source: "interactive-accepted", completeSetup: true });
    assert.equal(record.artifacts.some(item => item.path === fixture.settings), false,
      "the record claims an edit ACC did not make");
    const [after] = await fixture.detect();
    assert.equal(after.commandApproval.state, "unmatchable");
    assert.match(after.inboundDelivery.diagnostic, /On Windows ACC adds no allow rule/);

    const second = await fixture.run({ recorded: await fixture.recorded() });
    assert.deepEqual(second.questions, []);
    assert.equal(await fixture.read(), before);
    await fixture.run({ action: "uninstall", recorded: await fixture.recorded() });
    assert.equal(await fixture.read(), before);

    const off = await machine(t, "win32");
    const untouched = await off.read();
    const { questions } = await off.run({ recorded: [], interactive: false,
      options: { delivery: "off" } });
    assert.deepEqual(questions, []);
    assert.equal(await off.read(), untouched);
    await off.run({ action: "uninstall", recorded: await off.recorded() });
    assert.equal(await off.read(), untouched);
  });
