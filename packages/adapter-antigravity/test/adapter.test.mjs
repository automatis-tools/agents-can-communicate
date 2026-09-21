import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CAPABILITY_SHAPE, effectiveCapabilities } from "@agents-can-communicate/adapter-sdk";

import { ANTIGRAVITY_CLI_VERSION, createAntigravityAdapter } from "../src/adapter.mjs";

const CERTIFIED = { clientVersion: ANTIGRAVITY_CLI_VERSION, platform: "darwin-arm64" };
const trueOnes = capabilities => Object.entries(CAPABILITY_SHAPE)
  .flatMap(([group, names]) => names.filter(name => capabilities[group][name] === true)
    .map(name => `${group}.${name}`)).sort();

test("only what a capture in this package shows is declared true", () => {
  const adapter = createAntigravityAdapter();

  assert.deepEqual(trueOnes(adapter.capabilities),
    ["context.beforeTurnInjection", "delivery.nextTurn", "lifecycle.sessionStart"]);
});

test("the capabilities this client does not have stay false", () => {
  const { capabilities } = createAntigravityAdapter();

  // No tool event loads, so there is nothing to guard. The Gemini CLI adapter
  // has guards.beforeWrite and this one must not inherit it.
  assert.equal(capabilities.guards.beforeWrite, false);
  assert.equal(capabilities.guards.beforeShell, false);
  assert.equal(capabilities.guards.beforeRead, false);
  // SessionEnd is accepted into the config and never fires.
  assert.equal(capabilities.lifecycle.sessionEnd, false);
  assert.equal(capabilities.lifecycle.heartbeat, false);
  // agy agentapi send-message is a hidden subcommand with no captured
  // behaviour and no binary on disk.
  assert.equal(capabilities.delivery.livePush, false);
  assert.equal(capabilities.delivery.replyRoute, false);
});

test("a client that is not the captured one is certified for nothing", () => {
  const adapter = createAntigravityAdapter();

  assert.deepEqual(trueOnes(effectiveCapabilities(adapter, CERTIFIED)),
    ["context.beforeTurnInjection", "delivery.nextTurn", "lifecycle.sessionStart"]);
  for (const facts of [{ clientVersion: "1.2.6", platform: "darwin-arm64" },
    { clientVersion: ANTIGRAVITY_CLI_VERSION, platform: "linux-x64" },
    { clientVersion: "unknown", platform: "darwin-arm64" }, {}]) {
    assert.deepEqual(trueOnes(effectiveCapabilities(adapter, facts)), [],
      `${JSON.stringify(facts)} is not the client that was captured`);
  }
});

test("every certified capability names a fixture shipped in this package", async () => {
  const adapter = createAntigravityAdapter();
  const shipped = JSON.parse(await readFile(new URL("../package.json", import.meta.url))).files;

  for (const item of adapter.certification.evidence) {
    assert.equal(item.client, "antigravity-cli");
    assert.equal(shipped.includes(item.fixture), true, `${item.fixture} is not shipped`);
    assert.equal(shipped.includes(item.provenance), true, `${item.provenance} is not shipped`);
    await readFile(new URL(`../${item.fixture}`, import.meta.url));
  }
  assert.equal(shipped.includes("fixtures/"), false,
    "a wildcard fixture directory can publish documentation-derived material");
});

test("the manifest probes the binary this client really installs", () => {
  const adapter = createAntigravityAdapter();

  assert.equal(adapter.client.command, "agy");
  assert.equal(adapter.client.certificationName, "antigravity-cli");
  assert.equal(adapter.id, "antigravity");
});

test("the adapter reads the event from its argument, through the manifest", async () => {
  const adapter = createAntigravityAdapter();
  const payload = JSON.parse(await readFile(
    new URL("../fixtures/SessionStart-1.2.7.json", import.meta.url), "utf8"));

  assert.equal(adapter.normalizeHook(payload, { args: ["SessionStart"] }).kind, "sessionStart");
  assert.throws(() => adapter.normalizeHook(payload, { args: [] }),
    /unrecognised Antigravity hook event/);
});

test("renderContextResult is present, because receipts advance from ids alone", () => {
  const adapter = createAntigravityAdapter();

  assert.equal(typeof adapter.renderContextResult, "function");
  assert.equal(typeof adapter.renderContext, "function");
});

test("the delivery fallback says what stays true when the client is uncertified", () => {
  const adapter = createAntigravityAdapter();

  assert.match(adapter.deliveryFallback.diagnostic, /acc inbox/);
  assert.match(adapter.deliveryFallback.diagnostic, new RegExp(ANTIGRAVITY_CLI_VERSION));
});

test("doctor names the state where files exist and nothing is registered", async () => {
  const adapter = createAntigravityAdapter();

  const report = await adapter.doctor({ home: "/nonexistent-home",
    antigravityHookLocation: "global", probeHooks: async () => ({ hooks: [] }) });

  assert.equal(report.diagnostics.some(line => /not registered/.test(line)), true);
  assert.equal(report.diagnostics.some(line => /no tool guard|no session end/.test(line)), true);
});

test("evidence the tarball does not ship is still kept in the repository", async () => {
  // The packaged allowlist refuses a fixture no certification entry references,
  // so a tarball's fixtures are exactly its evidence. These are not evidence
  // for a capability - they are what this client answers when a registration
  // does not take - and they are the reason install reads the hook list back
  // instead of trusting its own write. Named here so they are not deleted for
  // looking unused.
  const shipped = JSON.parse(await readFile(new URL("../package.json", import.meta.url))).files;
  for (const name of ["PostInvocation-1.2.7", "Stop-1.2.7", "Stop-continued-1.2.7",
    "SessionStart-no-workspace-1.2.7", "Stop-no-workspace-1.2.7",
    "hook-process-environment-1.2.7", "PreInvocation-tui-1.2.7",
    "tui-transcript-injection-1.2.7",
    "hooks-readback-empty-1.2.7", "hooks-readback-registered-1.2.7",
    "hooks-readback-dropped-1.2.7", "hooks-readback-gemini-shape-1.2.7",
    "hooks-readback-foreign-key-1.2.7", "hooks-readback-namespace-collision-1.2.7"]) {
    const captured = JSON.parse(await readFile(
      new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
    assert.equal(typeof captured, "object");
    assert.equal(shipped.includes(`fixtures/${name}.json`), false,
      `fixtures/${name}.json is published but no certification entry references it`);
  }
});
