import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

import { applyPlan } from "../src/apply.mjs";
import { loadOwnership } from "../src/ownership.mjs";
import { planInstallation } from "../src/plan.mjs";

// Two ACC data homes on one machine: the operator's own, and a separate one -
// an isolated test home, say - that installed nothing for this client. On
// 2026-10-05 `acc uninstall` in the separate home removed the operator's Claude
// Code, Codex, Gemini CLI, Grok and Antigravity wiring, because an uninstall
// visited every client present on the machine (#253).
async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-own-home-")));
  const own = await realpath(await mkdtemp(path.join(tmpdir(), "acc-own-data-")));
  const other = await realpath(await mkdtemp(path.join(tmpdir(), "acc-other-data-")));
  t.after(() => Promise.all([home, own, other].map(dir => rm(dir, { recursive: true, force: true }))));
  await writeFile(path.join(home, "config.toml"), 'default_model = "k3"\n');
  const context = dataHome => ({ home, dataHome, configDir: home, codexHome: path.join(home, ".codex") });
  return { home, own, other, context };
}

const adapters = () => [createKimiAdapter()];
const present = list => list.map(adapter => ({ adapterId: adapter.id, displayName: adapter.displayName,
  present: true, version: "1.0.0", installed: false, diagnostics: [],
  capabilities: adapter.capabilities, error: null }));

async function installFrom(m, dataHome) {
  const list = adapters();
  await applyPlan({ plan: planInstallation({ adapters: list, detected: present(list),
    context: m.context(dataHome) }), adapters: list, context: m.context(dataHome), dataHome });
}

const uninstallPlan = async (m, dataHome, requested = []) => {
  const list = adapters();
  return planInstallation({ adapters: list, detected: present(list), context: m.context(dataHome),
    action: "uninstall", recorded: (await loadOwnership({ dataHome })).installs, requested });
};

test("an uninstall leaves a client that another data home wired", async t => {
  const m = await machine(t);
  await installFrom(m, m.own);
  const wired = await readFile(path.join(m.home, "config.toml"), "utf8");

  const plan = await uninstallPlan(m, m.other);
  const list = adapters();
  await applyPlan({ plan, adapters: list, context: m.context(m.other), dataHome: m.other });

  assert.deepEqual(plan.operations.map(operation => operation.adapterId), []);
  const [skipped] = plan.skipped;
  assert.equal(skipped.adapterId, "kimi");
  assert.match(skipped.reason, /not installed from this ACC data home/);
  assert.match(skipped.reason, /acc uninstall --adapter kimi/);
  assert.equal(await readFile(path.join(m.home, "config.toml"), "utf8"), wired);
  assert.equal((await loadOwnership({ dataHome: m.own })).installs.length, 1);
});

test("naming the client still removes its wiring without a record", async t => {
  const m = await machine(t);
  await installFrom(m, m.own);

  const plan = await uninstallPlan(m, m.other, ["kimi"]);

  assert.deepEqual(plan.operations.map(operation => [operation.adapterId, operation.action]),
    [["kimi", "uninstall"]]);
});

test("an uninstall still removes what its own data home installed", async t => {
  const m = await machine(t);
  await installFrom(m, m.own);

  const plan = await uninstallPlan(m, m.own);

  assert.deepEqual(plan.operations.map(operation => [operation.adapterId, operation.action]),
    [["kimi", "uninstall"]]);
});
