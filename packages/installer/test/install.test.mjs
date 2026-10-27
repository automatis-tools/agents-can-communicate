import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

import { applyPlan } from "../src/apply.mjs";
import { loadOwnership } from "../src/ownership.mjs";
import { planInstallation } from "../src/plan.mjs";

const ALL = () => [createClaudeCodeAdapter(), createCodexAdapter(),
  createGeminiCliAdapter(), createKimiAdapter()];

const PLAN_CONTEXT = { home: "/acc-plan-fixture/home", dataHome: "/acc-plan-fixture/data",
  configDir: "/acc-plan-fixture/home", codexHome: "/acc-plan-fixture/home/.codex" };

async function snapshot(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result.push({ path: name, kind: "directory" }, ...await snapshot(root, name));
    } else if (entry.isSymbolicLink()) {
      result.push({ path: name, kind: "symlink", target: await readlink(path.join(root, name)) });
    } else {
      assert.equal(entry.isFile(), true, `unexpected filesystem entry: ${name}`);
      result.push({ path: name, kind: "file", bytes: await readFile(path.join(root, name)) });
    }
  }
  return result;
}

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-inst-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-inst-data-")));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));

  // Configuration these clients already have, with settings of the user's own.
  await mkdir(path.join(home, ".gemini"), { recursive: true });
  await writeFile(path.join(home, ".gemini", "settings.json"),
    '{"theme":"dark"}\n');
  await writeFile(path.join(home, "settings.json"), '{"theme":"dark"}\n');
  await mkdir(path.join(home, ".agents", "plugins"), { recursive: true });
  await writeFile(path.join(home, ".agents", "plugins", "marketplace.json"),
    '{"name":"local-marketplace","plugins":[]}\n');
  await writeFile(path.join(home, "config.toml"), 'default_model = "k3"\n');

  return { home, dataHome,
    context: { home, dataHome, configDir: home, codexHome: path.join(home, ".codex") } };
}

const detected = (adapters, present) => adapters.map(adapter => ({
  adapterId: adapter.id, displayName: adapter.displayName,
  present: present.includes(adapter.id), version: "1.0.0", installed: false,
  diagnostics: [], capabilities: adapter.capabilities, error: null }));

test("a plan names exactly what it would touch, in a stable order", () => {
  const context = { ...PLAN_CONTEXT };
  const adapters = ALL();

  const plan = planInstallation({ adapters,
    detected: detected(adapters, ["codex", "kimi"]), context });

  assert.deepEqual(plan.operations.map(operation => operation.adapterId),
    ["codex", "kimi"]);
  for (const operation of plan.operations) {
    assert.equal(operation.action, "install");
    assert.equal(operation.artifacts.length > 0, true);
    for (const artifact of operation.artifacts) {
      assert.equal(path.isAbsolute(artifact.path), true, `${artifact.path} is relative`);
      // tree: a directory ACC creates outright. merge: a file the user owns
      // that ACC adds entries to. The distinction decides what uninstall may
      // delete, so it is part of the plan rather than an implementation detail.
      assert.equal(["file", "tree", "merge"].includes(artifact.kind), true,
        `${artifact.path} has kind ${artifact.kind}`);
    }
  }
});

test("a plan is deterministic, so two runs can be compared", () => {
  const context = { ...PLAN_CONTEXT };
  const adapters = ALL();
  const of = () => JSON.stringify(planInstallation({ adapters,
    detected: detected(adapters, ["codex", "kimi", "gemini_cli"]), context }));

  assert.equal(of(), of());
});

test("an absent client is skipped with the reason, not silently dropped", () => {
  const context = { ...PLAN_CONTEXT };
  const adapters = ALL();

  const plan = planInstallation({ adapters, detected: detected(adapters, ["kimi"]),
    context });

  const skipped = plan.skipped.map(entry => entry.adapterId).sort();
  assert.deepEqual(skipped, ["claude_code", "codex", "gemini_cli"]);
  assert.match(plan.skipped[0].reason, /not installed on this machine/);
});

test("a dry run touches nothing", async t => {
  const { home, dataHome, context } = await machine(t);
  const adapters = ALL().map(adapter => ({ ...adapter }));
  const calls = adapters.flatMap(adapter => ["install", "uninstall"].map(method => ({
    name: `${adapter.id}.${method}`, spy: t.mock.method(adapter, method) })));
  const beforeHome = await snapshot(home);
  const beforeDataHome = await snapshot(dataHome);

  const plan = planInstallation({ adapters,
    detected: detected(adapters, ["codex", "kimi"]), context });
  const result = await applyPlan({ plan, adapters, context, dataHome, dryRun: true });

  assert.equal(result.dryRun, true);
  for (const { name, spy } of calls) assert.equal(spy.mock.callCount(), 0, `${name} ran during dry run`);
  assert.deepEqual(await snapshot(home), beforeHome, "dry run changed client configuration");
  assert.deepEqual(await snapshot(dataHome), beforeDataHome, "dry run changed ACC data or ownership");
  assert.deepEqual((await loadOwnership({ dataHome })).installs, []);
});

test("apply installs, and what it planned is what it wrote", async t => {
  const { context, dataHome } = await machine(t);
  const adapters = ALL();
  const plan = planInstallation({ adapters,
    detected: detected(adapters, ["codex", "kimi"]), context });

  const result = await applyPlan({ plan, adapters, context, dataHome });

  assert.deepEqual(result.failed, [], "apply reported an adapter failure");
  assert.deepEqual(result.operations.map(operation => operation.adapterId), ["codex", "kimi"],
    "apply must report exactly the two planned adapters");
  // The drift this guards against: a plan that describes one thing while
  // install does another makes `--dry-run` a decoration.
  for (const operation of result.operations) {
    const planned = plan.operations.find(entry => entry.adapterId === operation.adapterId);
    assert.deepEqual([...operation.changes].sort(),
      [...planned.artifacts.map(artifact => artifact.path)].sort(),
      `${operation.adapterId} wrote something other than what it planned`);
  }
});

test("an install is recorded so it can be undone later", async t => {
  const { context, dataHome } = await machine(t);
  const adapters = ALL();
  const plan = planInstallation({ adapters, detected: detected(adapters, ["kimi"]),
    context });

  await applyPlan({ plan, adapters, context, dataHome });

  const record = await loadOwnership({ dataHome });
  assert.deepEqual(record.installs.map(install => install.adapterId), ["kimi"]);
  assert.equal(record.installs[0].artifacts.some(a => a.kind === "merge"), true,
    "the user's config was recorded as owned outright");
});

test("installing twice leaves one record and one set of entries", async t => {
  const { context, dataHome, home } = await machine(t);
  const adapters = ALL();
  const plan = () => planInstallation({ adapters, detected: detected(adapters, ["kimi"]),
    context });

  await applyPlan({ plan: plan(), adapters, context, dataHome });
  const afterFirst = await readFile(path.join(home, "config.toml"), "utf8");
  await applyPlan({ plan: plan(), adapters, context, dataHome });

  assert.equal(await readFile(path.join(home, "config.toml"), "utf8"), afterFirst);
  assert.equal((await loadOwnership({ dataHome })).installs.length, 1);
});

test("the user's own settings survive an install", async t => {
  const { context, dataHome, home } = await machine(t);
  const adapters = ALL();
  const plan = planInstallation({ adapters,
    detected: detected(adapters, ["gemini_cli", "kimi"]), context });

  await applyPlan({ plan, adapters, context, dataHome });

  assert.equal(JSON.parse(await readFile(
    path.join(home, ".gemini", "settings.json"), "utf8")).theme, "dark");
  assert.match(await readFile(path.join(home, "config.toml"), "utf8"),
    /default_model = "k3"/);
});

test("uninstall removes ACC and leaves the rest of the file alone", async t => {
  const { context, dataHome, home } = await machine(t);
  const adapters = ALL();
  const original = await readFile(path.join(home, "config.toml"), "utf8");
  await applyPlan({ plan: planInstallation({ adapters,
    detected: detected(adapters, ["kimi"]), context }), adapters, context, dataHome });

  const result = await applyPlan({ plan: planInstallation({ adapters,
    detected: detected(adapters, ["kimi"]), context, action: "uninstall",
    recorded: (await loadOwnership({ dataHome })).installs }),
    adapters, context, dataHome });

  assert.equal(result.operations[0].action, "uninstall");
  assert.equal(await readFile(path.join(home, "config.toml"), "utf8"), original);
  assert.deepEqual((await loadOwnership({ dataHome })).installs, []);
});

test("delivery policy is deterministic and carried into adapter-owned install work",
  async t => {
    const { context, dataHome } = await machine(t);
    const seen = [];
    const adapter = {
      id: "live_fixture", displayName: "Live Fixture",
      capabilities: { delivery: { livePush: true } },
      planInstall: installContext => {
        seen.push(["plan", installContext.requestedLivePolicy,
          installContext.livePolicy]);
        return [];
      },
      install: async installContext => {
        seen.push(["apply", installContext.requestedLivePolicy,
          installContext.livePolicy]);
        return { changes: [], diagnostics: [] };
      },
    };
    const detectedFixture = [{ adapterId: adapter.id, displayName: adapter.displayName,
      present: true, version: "1.0.0", installed: false,
      capabilities: { delivery: { livePush: true } },
      nativeDelivery: { state: "eligible", reasonCode: null, realExecutable: "/vendor/live",
        probe: null, eligibility: { eligible: true, protocolContract: "live-v1" },
        activationPlan: { eligible: true, reasonCode: null, mechanisms: [] } } }];
    const plan = planInstallation({ adapters: [adapter], detected: detectedFixture,
      context, deliveryByAdapter: { live_fixture: "actionable" } });

    assert.equal(JSON.stringify(plan), JSON.stringify(planInstallation({ adapters: [adapter],
      detected: detectedFixture, context, deliveryByAdapter: { live_fixture: "actionable" } })));
    assert.deepEqual(plan.operations[0].livePolicy, "actionable");
    assert.deepEqual(plan.operations[0].effectiveLivePolicy, "actionable");
    await applyPlan({ plan, adapters: [adapter], context, dataHome });
    assert.deepEqual(seen, [
      ["plan", "actionable", "actionable"],
      ["plan", "actionable", "actionable"],
      ["apply", "actionable", "actionable"],
    ]);
  });

test("unsupported adapters receive off and report durable fallback", async t => {
  const { context, dataHome } = await machine(t);
  let appliedContext;
  const adapter = {
    id: "durable_fixture", displayName: "Durable Fixture",
    capabilities: { delivery: { livePush: false } },
    deliveryFallback: { diagnostic:
      "Durable Fixture capture stopped at its trust warning; use next-turn or inbox" },
    planInstall: () => [],
    install: async installContext => {
      appliedContext = installContext;
      return { changes: [], diagnostics: [] };
    },
  };
  const plan = planInstallation({ adapters: [adapter], detected: [{
    adapterId: adapter.id, displayName: adapter.displayName, present: true,
    version: "1.0.0", installed: false }], context,
  deliveryByAdapter: { durable_fixture: "all" } });

  assert.equal(plan.operations[0].livePolicy, "all");
  assert.equal(plan.operations[0].effectiveLivePolicy, "off");
  assert.equal(plan.operations[0].deliveryDiagnostic,
    "Durable Fixture capture stopped at its trust warning; use next-turn or inbox");
  const result = await applyPlan({ plan, adapters: [adapter], context, dataHome });
  assert.equal(appliedContext.requestedLivePolicy, "all");
  assert.equal(appliedContext.livePolicy, "off");
  assert.match(result.operations[0].diagnostics.join("\n"), /capture stopped/);
});

test("an unknown delivery policy is refused rather than treated as opt-in", () => {
  const context = { ...PLAN_CONTEXT };
  const adapters = ALL();
  assert.throws(() => planInstallation({ adapters, detected: detected(adapters, ["kimi"]),
    context, deliveryByAdapter: { kimi: "sometimes" } }), /unknown delivery policy/);
  assert.throws(() => planInstallation({ adapters, detected: detected(adapters, ["kimi"]),
    context, deliveryByAdapter: { nobody: "off" } }), /not part of this install/);
});
