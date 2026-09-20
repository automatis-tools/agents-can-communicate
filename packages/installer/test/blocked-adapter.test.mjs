import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAntigravityAdapter } from "@agents-can-communicate/adapter-antigravity";

import { detectInstallation } from "../src/detect.mjs";
import { planInstallation } from "../src/plan.mjs";
import { recordInstall } from "../src/ownership.mjs";

// An adapter can know, without writing anything, that it cannot be installed
// right now - Antigravity CLI cannot, until somebody chooses between a
// machine-wide and a per-workspace hook registration (issue #178). A refusal
// that throws takes the whole command down with it and stops the other clients
// being wired; a skip names the reason and installs the rest.
const antigravity = () => createAntigravityAdapter();
const entryFor = (adapter, extra = {}) => ({ adapterId: adapter.id,
  displayName: adapter.displayName, present: true, version: "1.2.7", installed: false,
  diagnostics: [], capabilities: adapter.capabilities, error: null, ...extra });

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-blocked-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-blocked-data-")));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { home, dataHome, context: { home, dataHome } };
}

test("detection reports the choice an install is waiting on", async t => {
  const { context } = await machine(t);
  const adapter = antigravity();

  const [entry] = await detectInstallation({ adapters: [adapter],
    context: { ...context, probeHooks: async () => ({ hooks: [] }) },
    probe: async () => "1.2.7", probeTimeoutMs: 1_000 });

  assert.equal(typeof entry.blocked?.reason, "string");
  assert.match(entry.blocked.reason, /global|workspace/);
});

test("a blocked adapter is skipped by name, and does not fail the run", async t => {
  const { context } = await machine(t);
  const adapter = antigravity();

  const plan = planInstallation({ adapters: [adapter],
    detected: [entryFor(adapter, { blocked: { reason: "no location was chosen" } })],
    context, action: "install" });

  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.skipped, [{ adapterId: "antigravity",
    reason: "no location was chosen" }]);
});

test("a blocked adapter that ACC already installed can still be removed", async t => {
  const { context, dataHome } = await machine(t);
  const adapter = antigravity();
  await recordInstall({ dataHome, adapterId: adapter.id, version: "1.2.7",
    artifacts: [{ path: path.join(context.home, ".gemini", "config", "hooks.json"),
      kind: "merge" }] });
  const recorded = (await (await import("../src/ownership.mjs"))
    .loadOwnership({ dataHome })).installs;

  const plan = planInstallation({ adapters: [adapter],
    detected: [entryFor(adapter, { blocked: { reason: "no location was chosen" } })],
    context, action: "uninstall", recorded });

  assert.deepEqual(plan.skipped, [],
    "a recorded install is removable whatever is blocking a new one");
  assert.equal(plan.operations.length, 1);
});

test("nothing is blocked once a location is named", async t => {
  const { context } = await machine(t);
  const adapter = antigravity();

  const [entry] = await detectInstallation({ adapters: [adapter],
    context: { ...context, antigravityHookLocation: "global",
      probeHooks: async () => ({ hooks: [] }) },
    probe: async () => "1.2.7", probeTimeoutMs: 1_000 });

  assert.equal(entry.blocked, undefined);
});
