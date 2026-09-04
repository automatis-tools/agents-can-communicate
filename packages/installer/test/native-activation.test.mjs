import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPlan } from "../src/apply.mjs";
import { detectInstallation } from "../src/detect.mjs";
import { livePolicyOf, shimDirFor } from "../src/native-activation.mjs";
import { loadOwnership, recordInstall } from "../src/ownership.mjs";
import { planInstallation } from "../src/plan.mjs";
import { BLOCK_BEGIN } from "../src/shell-bootstrap.mjs";

// Kept cohesive above 300 lines because every case drives one fixture
// adapter through detection, planning, apply, and ownership on one temporary
// home; splitting would duplicate that machine and hide the lifecycle.

const PLATFORM = "darwin-arm64";
const PROBE = { supported: true, clientVersion: "2.1.258", protocolContract: "fixture-native-v1",
  executableFingerprint: null, modes: ["livePush"], reasonCode: null };

async function machine(t, { shell = "zsh" } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-native-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-native-data-")));
  t.after(() => Promise.all([home, dataHome].map(d => rm(d, { recursive: true, force: true }))));
  const vendorDir = path.join(home, "vendor");
  await mkdir(vendorDir);
  const vendor = path.join(vendorDir, "fixture-client");
  await writeFile(vendor, "#!/bin/sh\necho 2.1.258\n", { mode: 0o700 });
  await writeFile(path.join(home, ".zshrc"), "export USER_STUFF=1\n");
  const stateRoot = path.join(dataHome, "acc");
  const context = { home, dataHome, configDir: path.join(home, ".claude"), stateRoot, shell,
    env: { PATH: `${shimDirFor(stateRoot)}${path.delimiter}${vendorDir}` } };
  return { home, dataHome, vendor, vendorDir, stateRoot, context, rcFile: path.join(home, ".zshrc"),
    shimDir: shimDirFor(stateRoot) };
}

function fixtureAdapter({ service = null, probe = async () => PROBE, log = [] } = {}) {
  return {
    id: "fixture", displayName: "Fixture Client",
    client: { command: "fixture-client", certificationName: "fixture-client",
      versionArgs: ["--version"] },
    capabilities: { delivery: { livePush: true } },
    nativeDelivery: { minimumByPlatform: { [PLATFORM]: "2.1.258" },
      anchors: [{ platform: PLATFORM, version: "2.1.258", protocolContract: "fixture-native-v1" }],
      knownBad: [], activationKinds: ["shell-bootstrap", "native-service"] },
    planInstall: () => [],
    detect: async () => { log.push("detect"); return { ok: true, diagnostics: ["registered"] }; },
    install: async context => { log.push(["install", context.livePolicy]); return { changes: [] }; },
    uninstall: async () => { log.push("uninstall"); return { changes: [] }; },
    probeNativeDelivery: async () => { log.push("probe"); return probe(); },
    planNativeActivation: async ({ detection }) => {
      log.push("plan");
      return { eligible: true, reasonCode: null, mechanisms: [
        { kind: "shell-bootstrap", command: "fixture-client",
          realExecutable: detection.realExecutable, prefixArgs: ["--captured", "value"] },
        ...(service === null ? [] : [service]),
      ] };
    },
  };
}

const detect = (adapter, context) => detectInstallation({ adapters: [adapter], context,
  probe: async () => "2.1.258", platform: PLATFORM, pathEnv: context.env.PATH });

const entryFor = detected => detected[0];

test("detection reports a closed native state and only ever probes", async t => {
  const here = await machine(t);
  const log = [];
  const [entry] = await detect(fixtureAdapter({ log }), here.context);
  assert.equal(entry.nativeDelivery.state, "eligible");
  assert.equal(entry.nativeDelivery.realExecutable, here.vendor,
    "the shim directory must never be the resolved executable");
  assert.deepEqual(entry.nativeDelivery.activationPlan.mechanisms.map(m => m.kind),
    ["shell-bootstrap"]);
  assert.deepEqual(log, ["probe", "plan", "detect"]);
  const plain = { ...fixtureAdapter(), nativeDelivery: undefined };
  assert.equal((await detect(plain, here.context))[0].nativeDelivery.reasonCode,
    "native_delivery_unsupported");
  const bash = await machine(t, { shell: "bash" });
  const [onBash] = await detect(fixtureAdapter(), bash.context);
  assert.deepEqual([onBash.nativeDelivery.state, onBash.nativeDelivery.reasonCode],
    ["degraded", "unsupported_shell"]);
  const old = await detect(fixtureAdapter({ probe: async () => ({ ...PROBE,
    protocolContract: "other-v1" }) }), here.context);
  assert.deepEqual([old[0].nativeDelivery.state, old[0].nativeDelivery.reasonCode],
    ["degraded", "protocol_mismatch"]);
});

test("policies are explicit per adapter, and an ineligible client cannot be activated",
  async t => {
    const here = await machine(t);
    const eligible = fixtureAdapter();
    const other = { ...fixtureAdapter(), id: "other", displayName: "Other",
      client: { command: "other-client" } };
    const detected = [...await detect(eligible, here.context),
      ...await detect(other, here.context)];
    const plan = planInstallation({ adapters: [eligible, other], detected, context: here.context,
      deliveryByAdapter: { fixture: "actionable" } });
    const byId = Object.fromEntries(plan.operations.map(op => [op.adapterId, op]));
    assert.equal(byId.fixture.effectiveLivePolicy, "actionable");
    assert.equal(byId.fixture.nativeActivation.livePolicy, "actionable");
    assert.match(byId.fixture.summary.join("\n"), /create shim .*fixture-client/);
    assert.match(byId.fixture.summary.join("\n"), /PATH block to .*\.zshrc/);
    assert.equal(byId.other.livePolicy, "off", "a missing map entry is off");
    assert.equal(byId.other.nativeActivation, undefined);
    const forced = planInstallation({ adapters: [eligible, other], detected, context: here.context,
      deliveryByAdapter: { other: "all" } });
    const otherOp = forced.operations.find(op => op.adapterId === "other");
    assert.equal(otherOp.effectiveLivePolicy, "off");
    assert.match(otherOp.deliveryDiagnostic, /version_unavailable/);
  });

test("apply activates, records owned bytes, and a second policy regenerates only the shim",
  async t => {
    const here = await machine(t);
    const log = [];
    const adapter = fixtureAdapter({ log });
    const detected = await detect(adapter, here.context);
    const apply = policy => applyPlan({ plan: planInstallation({ adapters: [adapter], detected,
      context: here.context, deliveryByAdapter: { fixture: policy } }), adapters: [adapter],
    context: here.context, dataHome: here.dataHome,
    activation: { node: "/usr/bin/env", bootstrap: "/abs/acc-bootstrap.mjs" } });

    const first = await apply("actionable");
    assert.deepEqual(first.failed, []);
    assert.equal(first.operations[0].appendedRcBlock, true);
    const shim = path.join(here.shimDir, "fixture-client");
    assert.equal((await stat(shim)).mode & 0o777, 0o700);
    const rc = await readFile(here.rcFile, "utf8");
    assert.match(rc, /^export USER_STUFF=1\n/);
    assert.equal(rc.includes(BLOCK_BEGIN), true);
    const record = (await loadOwnership({ dataHome: here.dataHome })).installs[0];
    assert.equal(livePolicyOf(record), "actionable");
    assert.equal(record.nativeActivation.protocolContract, "fixture-native-v1");
    assert.deepEqual(record.nativeActivation.mechanisms[0].ownedFiles.map(f => f.path), [shim]);
    assert.match(record.nativeActivation.mechanisms[0].ownedFiles[0].sha256, /^[0-9a-f]{64}$/);
    assert.match(await readFile(shim, "utf8"), /ACC_NATIVE_DELIVERY_POLICY='actionable'/);

    const second = await apply("all");
    assert.equal(second.operations[0].appendedRcBlock, false);
    assert.equal(await readFile(here.rcFile, "utf8"), rc, "the PATH block is not rewritten");
    assert.match(await readFile(shim, "utf8"), /ACC_NATIVE_DELIVERY_POLICY='all'/);
    assert.equal(livePolicyOf((await loadOwnership({ dataHome: here.dataHome })).installs[0]), "all");
    assert.deepEqual(log.filter(item => Array.isArray(item)),
      [["install", "actionable"], ["install", "all"]]);
  });

test("explicit off takes a recorded activation back and keeps the ordinary install", async t => {
  const here = await machine(t);
  const adapter = fixtureAdapter();
  const detected = await detect(adapter, here.context);
  const apply = policy => applyPlan({ plan: planInstallation({ adapters: [adapter], detected,
    context: here.context, deliveryByAdapter: { fixture: policy },
    recorded: [] }), adapters: [adapter], context: here.context, dataHome: here.dataHome,
  activation: { node: "/usr/bin/env", bootstrap: "/abs/acc-bootstrap.mjs" } });
  await apply("actionable");
  const recorded = (await loadOwnership({ dataHome: here.dataHome })).installs;
  const plan = planInstallation({ adapters: [adapter], detected, context: here.context,
    deliveryByAdapter: { fixture: "off" }, recorded });
  assert.equal(plan.operations[0].deactivation.livePolicy, "actionable");
  assert.match(plan.operations[0].summary.join("\n"), /remove shim/);
  const result = await applyPlan({ plan, adapters: [adapter], context: here.context,
    dataHome: here.dataHome });
  assert.deepEqual(result.failed, []);
  assert.equal(await readFile(here.rcFile, "utf8"), "export USER_STUFF=1\n");
  await assert.rejects(stat(path.join(here.shimDir, "fixture-client")));
  const after = (await loadOwnership({ dataHome: here.dataHome })).installs[0];
  assert.equal(after.nativeActivation, undefined);
  assert.equal(livePolicyOf(after), "off");
});

test("a native service is started only when absent and torn down only when ACC created it",
  async t => {
    const here = await machine(t);
    const commands = [];
    const exec = async (executable, args) => { commands.push([executable, ...args]); };
    const service = { kind: "native-service", serviceId: "vendor-daemon", preExisting: false,
      applyCommand: { executable: "/abs/vendor", args: ["daemon", "start"] },
      teardownCommand: { executable: "/abs/vendor", args: ["daemon", "stop"] } };
    const adapter = fixtureAdapter({ service });
    const detected = await detect(adapter, here.context);
    const install = await applyPlan({ plan: planInstallation({ adapters: [adapter], detected,
      context: here.context, deliveryByAdapter: { fixture: "actionable" } }), adapters: [adapter],
    context: here.context, dataHome: here.dataHome,
    activation: { node: "/usr/bin/env", bootstrap: "/abs/acc-bootstrap.mjs", exec } });
    assert.deepEqual(install.failed, []);
    assert.deepEqual(commands, [["/abs/vendor", "daemon", "start"]]);
    const record = (await loadOwnership({ dataHome: here.dataHome })).installs[0];
    const recordedService = record.nativeActivation.mechanisms.find(m => m.kind === "native-service");
    assert.equal(recordedService.createdByAcc, true);

    const uninstall = await applyPlan({ plan: planInstallation({ adapters: [adapter], detected,
      context: here.context, action: "uninstall",
      recorded: (await loadOwnership({ dataHome: here.dataHome })).installs }),
    adapters: [adapter], context: here.context, dataHome: here.dataHome, activation: { exec } });
    assert.deepEqual(uninstall.failed, []);
    assert.deepEqual(commands.at(-1), ["/abs/vendor", "daemon", "stop"]);
    assert.match(uninstall.operations[0].diagnostics.join("\n"), /stopped the vendor-daemon service/);

    // A pre-existing service is never touched, and a created one without a
    // vendor teardown is reported as retained.
    const preExisting = fixtureAdapter({ service: { ...service, preExisting: true } });
    const seen = await detect(preExisting, here.context);
    commands.length = 0;
    await applyPlan({ plan: planInstallation({ adapters: [preExisting], detected: seen,
      context: here.context, deliveryByAdapter: { fixture: "actionable" } }),
    adapters: [preExisting], context: here.context, dataHome: here.dataHome,
    activation: { node: "/usr/bin/env", bootstrap: "/abs/acc-bootstrap.mjs", exec } });
    const removal = await applyPlan({ plan: planInstallation({ adapters: [preExisting],
      detected: seen, context: here.context, action: "uninstall",
      recorded: (await loadOwnership({ dataHome: here.dataHome })).installs }),
    adapters: [preExisting], context: here.context, dataHome: here.dataHome, activation: { exec } });
    assert.deepEqual(commands, []);
    assert.match(removal.operations[0].diagnostics.join("\n"),
      /retained the vendor-daemon service \(it existed before ACC\)/);
  });

test("a refused shell step fails the operation and writes no shell bytes", async t => {
  const here = await machine(t);
  await writeFile(here.rcFile, `${BLOCK_BEGIN}\nexport PATH="/someone/else:$PATH"\n# <<< agents-can-communicate native delivery <<<\n`);
  const adapter = fixtureAdapter();
  const detected = await detect(adapter, here.context);
  const result = await applyPlan({ plan: planInstallation({ adapters: [adapter], detected,
    context: here.context, deliveryByAdapter: { fixture: "actionable" } }), adapters: [adapter],
  context: here.context, dataHome: here.dataHome,
  activation: { node: "/usr/bin/env", bootstrap: "/abs/acc-bootstrap.mjs" } });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /rc_block_modified/);
  await assert.rejects(stat(here.shimDir));
  assert.deepEqual((await loadOwnership({ dataHome: here.dataHome })).installs, []);
});

test("a dry run computes the activation and executes nothing", async t => {
  const here = await machine(t);
  const adapter = fixtureAdapter();
  const detected = await detect(adapter, here.context);
  const plan = planInstallation({ adapters: [adapter], detected, context: here.context,
    deliveryByAdapter: { fixture: "all" } });
  const result = await applyPlan({ plan, adapters: [adapter], context: here.context,
    dataHome: here.dataHome, dryRun: true });
  assert.equal(result.operations[0].applied, false);
  assert.equal(plan.operations[0].nativeActivation.shimDir, here.shimDir);
  await assert.rejects(stat(here.shimDir));
  assert.equal(await readFile(here.rcFile, "utf8"), "export USER_STUFF=1\n");
});

test("a 0.2 ownership record keeps native delivery off and is not migrated", async t => {
  const here = await machine(t);
  const adapter = fixtureAdapter();
  const artifact = path.join(here.home, ".claude", "settings.json");
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, "{}\n");
  await recordInstall({ dataHome: here.dataHome, adapterId: "fixture", version: "2.1.258",
    accVersion: "0.2.0", artifacts: [{ path: artifact, kind: "merge" }] });
  const before = await readFile(path.join(here.dataHome, "acc", "installs.json"), "utf8");
  const recorded = (await loadOwnership({ dataHome: here.dataHome })).installs;
  assert.equal(livePolicyOf(recorded[0]), "off");
  assert.equal(recorded[0].nativeActivation, undefined);
  const detected = await detect(adapter, here.context);
  const plan = planInstallation({ adapters: [adapter], detected, context: here.context,
    recorded, deliveryByAdapter: {} });
  assert.equal(plan.operations[0].effectiveLivePolicy, "off");
  assert.equal(plan.operations[0].nativeActivation, undefined);
  assert.equal(plan.operations[0].deactivation, undefined);
  assert.equal(await readFile(path.join(here.dataHome, "acc", "installs.json"), "utf8"), before,
    "reading the record must not rewrite it");
});

test("uninstall is driven by the record even when the client left PATH", async t => {
  const here = await machine(t);
  const adapter = fixtureAdapter();
  const detected = await detect(adapter, here.context);
  await applyPlan({ plan: planInstallation({ adapters: [adapter], detected, context: here.context,
    deliveryByAdapter: { fixture: "actionable" } }), adapters: [adapter], context: here.context,
  dataHome: here.dataHome, activation: { node: "/usr/bin/env", bootstrap: "/abs/acc-bootstrap.mjs" } });
  const gone = [{ ...detected[0], present: false, version: null,
    nativeDelivery: { state: "unsupported", reasonCode: "version_unavailable" } }];
  const plan = planInstallation({ adapters: [adapter], detected: gone, context: here.context,
    action: "uninstall", recorded: (await loadOwnership({ dataHome: here.dataHome })).installs });
  assert.equal(plan.operations[0].clientPresent, false);
  assert.equal(plan.operations[0].deactivation.livePolicy, "actionable");
  const result = await applyPlan({ plan, adapters: [adapter], context: here.context,
    dataHome: here.dataHome });
  assert.deepEqual(result.failed, []);
  assert.equal(await readFile(here.rcFile, "utf8"), "export USER_STUFF=1\n");
  assert.deepEqual((await loadOwnership({ dataHome: here.dataHome })).installs, []);
});
