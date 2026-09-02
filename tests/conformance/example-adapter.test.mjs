import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { defineAdapter, mergeOwnedConfig, ownedKeys, projectContext, removeOwnedConfig }
  from "@agents-can-communicate/adapter-sdk";

import { runAdapterConformance } from "./adapter-contract.mjs";

// A reference adapter over a fake harness config. It exists so the conformance
// runner is exercised before any real adapter depends on it: a matrix nothing
// has ever failed is indistinguishable from a matrix that checks nothing.
const roots = [];
after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

const UNRELATED = { theme: "dark", hooks: { UserPromptSubmit: ["someone-elses-hook"] } };
const ACC_ENTRIES = { accHooks: { SessionStart: ["acc attach"], SessionEnd: ["acc detach"] } };

async function createFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-conformance-")));
  roots.push(root);
  const configPath = path.join(root, "settings.json");
  await writeFile(configPath, `${JSON.stringify(UNRELATED, null, 2)}\n`);

  const read = async () => JSON.parse(await readFile(configPath, "utf8"));
  return {
    context: { configPath, runtimeDir: path.join(root, "runtime") },
    snapshot: read,
    valueOf: async key => (await read())[key],
  };
}

function createAdapter() {
  const read = async context => JSON.parse(await readFile(context.configPath, "utf8"));
  const write = async (context, value) =>
    writeFile(context.configPath, `${JSON.stringify(value, null, 2)}\n`);

  return defineAdapter({
    id: "example_harness",
    displayName: "Example Harness",
    client: { command: "example", versionArgs: ["--version"] },
    capabilities: {},
    certification: { evidence: [] },
    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),

    detect: async context => ({ ok: true, changes: [],
      diagnostics: [`config at ${context.configPath}`] }),

    install: async context => {
      const current = await read(context);
      await write(context, mergeOwnedConfig(current, ACC_ENTRIES));
      return { ok: true, changes: Object.keys(ACC_ENTRIES), diagnostics: [] };
    },

    uninstall: async context => {
      const current = await read(context);
      const removed = ownedKeys(current);
      await write(context, removeOwnedConfig(current));
      return { ok: true, changes: removed, diagnostics: [] };
    },

    doctor: async context => {
      const current = await read(context);
      const installed = ownedKeys(current).length > 0;
      return { ok: installed, changes: [],
        diagnostics: [installed ? "acc entries present" : "acc entries missing"] };
    },

    normalizeHook: async payload => ({
      kind: payload.hook_event_name === "SessionStart" ? "sessionStart"
        : payload.hook_event_name === "PreToolUse" ? "beforeTool" : "sessionEnd",
      sessionId: payload.session_id,
      cwd: payload.cwd,
      model: payload.model ?? null,
      parentSessionId: payload.parent_session_id ?? null,
      tool: payload.tool_name ?? null,
    }),

    renderContext: async (sync, options) => projectContext(sync, options),
  });
}

const hookFixtures = {
  sessionStart: { hook_event_name: "SessionStart", session_id: "abc-123", cwd: "/tmp/project",
    model: "example-model", transcript_path: "/should/not/be/copied" },
  beforeTool: { hook_event_name: "PreToolUse", session_id: "abc-123", cwd: "/tmp/project",
    tool_name: "Write", transcript_path: "/should/not/be/copied" },
  sessionEnd: { hook_event_name: "SessionEnd", session_id: "abc-123", cwd: "/tmp/project" },
};

// The same reference adapter with a native-delivery contract: a passing
// livePush capture anchors the minimum, and the three native methods return
// closed facts. It proves the runner accepts a native adapter and that a
// regular adapter without the contract keeps live delivery off.
function createNativeAdapter() {
  const regular = createAdapter();
  return defineAdapter({
    ...regular,
    client: { command: "example", certificationName: "example-client", versionArgs: ["--version"] },
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [{
      client: "example-client", version: "1.2.3", platform: "darwin-arm64",
      observedAt: "2026-09-02T12:00:00.000Z", capability: "delivery.livePush",
      fixture: "fixtures/delivery/example-client-1.2.3.json",
      provenance: "fixtures/certification-provenance.json", provenanceId: "native-1-2-3",
      idleBehavior: "offered", busyBehavior: "queued_after_turn", authorityLevel: "experimental",
      limitations: ["reference adapter only"], result: "pass",
    }] },
    nativeDelivery: {
      minimumByPlatform: { "darwin-arm64": "1.2.3" },
      anchors: [{ platform: "darwin-arm64", version: "1.2.3", protocolContract: "example-native-v1" }],
      knownBad: [],
      activationKinds: ["native-config"],
    },
    offerMessage: async () => ({ accepted: false, transport: "example", clientVersion: "1.2.3" }),
    probeNativeDelivery: async () => ({ supported: true, clientVersion: "1.2.3",
      protocolContract: "example-native-v1", executableFingerprint: null, modes: ["livePush"],
      reasonCode: null }),
    planNativeActivation: async () => ({ eligible: true, reasonCode: null,
      mechanisms: [{ kind: "native-config", artifactIds: ["example-owned-block"] }] }),
    bindNativeSession: async () => ({ supported: false, clientVersion: "1.2.3",
      protocolContract: "example-native-v1", modes: [], opaqueEndpointRef: null, leaseUntil: null,
      reasonCode: "handshake_failed" }),
  });
}

runAdapterConformance("example", { createAdapter, createFixture, hookFixtures });
runAdapterConformance("example native", { createAdapter: createNativeAdapter, createFixture,
  hookFixtures });

test("the native reference adapter exposes its contract while the regular one does not", () => {
  assert.equal(createAdapter().nativeDelivery, undefined);
  assert.equal(createAdapter().capabilities.delivery.livePush, false);
  const native = createNativeAdapter();
  assert.equal(native.capabilities.delivery.livePush, true);
  assert.deepEqual(native.nativeDelivery.minimumByPlatform, { "darwin-arm64": "1.2.3" });
  assert.equal(Object.isFrozen(native.nativeDelivery.anchors), true);
});

test("the reference adapter really does preserve unrelated configuration", async () => {
  const fixture = await createFixture();
  const adapter = createAdapter();

  await adapter.install(fixture.context);
  const installed = await fixture.snapshot();
  await adapter.uninstall(fixture.context);

  assert.deepEqual(installed.hooks, UNRELATED.hooks, "install disturbed a foreign hook");
  assert.deepEqual(await fixture.snapshot(), UNRELATED);
});

test("the conformance runner fails an adapter that breaks unrelated config", async () => {
  // Guards the guard: an adapter that overwrites the whole file must not pass.
  const fixture = await createFixture();
  const destructive = { ...createAdapter(),
    install: async context => {
      await writeFile(context.configPath, `${JSON.stringify(ACC_ENTRIES)}\n`);
      return { ok: true, changes: [], diagnostics: [] };
    } };

  await destructive.install(fixture.context);

  assert.equal((await fixture.snapshot()).theme, undefined,
    "the destructive adapter did not actually destroy anything");
  assert.notDeepEqual(await fixture.snapshot(), UNRELATED);
});
