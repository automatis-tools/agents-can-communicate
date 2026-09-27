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

/**
 * Issue #214 through the whole install path: detection, the operator's two
 * answers, the plan, the adapter's write, the record, a reinstall and an
 * uninstall - the real Antigravity adapter against a temporary home, with a
 * stand-in agy.
 *
 * It starts from the record 0.8.1 leaves for an operator who accepted live
 * delivery, because that is the machine the capture was taken on: consent to
 * live delivery on file, and no answer yet about the approval prompt.
 */
async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-agy-e2e-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, "data");
  const settings = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  await mkdir(path.dirname(settings), { recursive: true });
  await mkdir(path.join(home, "project"), { recursive: true });
  const relay = `command(sh "${home}/.gemini/config/acc/acc-relay.sh" start)`;
  await writeFile(settings, `${JSON.stringify({ colorScheme: "dark",
    trustedWorkspaces: [path.join(home, "project")], permissions: { allow: [relay] } },
  null, 2)}\n`);
  const agy = fakeAgy();
  const context = { ...clientContext(home, path.join(dataHome, "acc"),
    { env: {}, dataHome, cwd: path.join(home, "project") }), runAgy: agy.run,
  probeHooks: async () => ({ hooks: [{ name: "acc", enabled: true,
    actions: ["SessionStart", "PreInvocation", "Stop"].map(event => ({ event })) }] }) };
  const adapters = ALL_ADAPTERS().filter(adapter => adapter.id === "antigravity");
  // No agy on PATH: the version answer is the probe's, and no real binary runs.
  const detect = () => detectInstallation({ adapters, context, pathEnv: "",
    probe: async command => (command === "agy" ? "1.2.12" : null) });
  const run = async ({ action = "install", recorded, answers = [] }) => {
    const detected = await detect();
    const questions = [];
    const decided = action === "install" ? await decideDelivery({ options: {}, detected,
      recorded, dryRun: false, runtime: { isInteractive: () => true,
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
    rule: `command(${home}/.gemini/config/acc/acc-cli.sh)`,
    read: () => readFile(settings, "utf8"),
    recorded: async () => (await loadOwnership({ dataHome })).installs };
}

const ON_0_8_1 = [{ adapterId: "antigravity", deliveryPolicy: "actionable",
  deliveryDecision: { source: "interactive-accepted", completeSetup: true } }];

test("a yes adds the rule once, a reinstall keeps it, uninstall takes it back", async t => {
  const fixture = await machine(t);
  const before = await fixture.read();

  const first = await fixture.run({ recorded: ON_0_8_1, answers: [true] });
  assert.equal(first.questions.length, 1);
  assert.match(first.questions[0], /without an approval prompt/);
  const withRule = await fixture.read();
  assert.deepEqual(JSON.parse(withRule).permissions.allow,
    [...JSON.parse(before).permissions.allow, fixture.rule]);
  const [record] = await fixture.recorded();
  assert.equal(record.deliveryDecision.allowCommands, true);
  assert.equal(record.artifacts.some(item => item.path === fixture.settings
    && item.kind === "merge"), true, "the record does not say ACC edits the settings file");
  const [after] = await fixture.detect();
  assert.equal(after.commandApproval.state, "allowed");
  assert.match(after.inboundDelivery.diagnostic, /added by ACC/);

  // Reinstall and automatic refresh: the record answers, nobody is asked.
  const second = await fixture.run({ recorded: await fixture.recorded() });
  assert.deepEqual(second.questions, []);
  assert.equal(await fixture.read(), withRule);

  await fixture.run({ action: "uninstall", recorded: await fixture.recorded() });
  assert.equal(await fixture.read(), before);
});

test("a no leaves the settings alone and doctor names what it costs", async t => {
  const fixture = await machine(t);
  const before = await fixture.read();

  await fixture.run({ recorded: ON_0_8_1, answers: [false] });

  assert.equal(await fixture.read(), before);
  const [record] = await fixture.recorded();
  assert.equal(record.deliveryDecision.allowCommands, false);
  const [entry] = await fixture.detect();
  assert.equal(entry.commandApproval.state, "prompts");
  assert.match(entry.inboundDelivery.diagnostic, /live wake stops at/);
  assert.equal(entry.inboundDelivery.diagnostic.includes(fixture.rule), true);

  // Asked once: the recorded No is the answer from now on.
  const again = await fixture.run({ recorded: await fixture.recorded() });
  assert.deepEqual(again.questions, []);
  assert.equal(await fixture.read(), before);
});
