import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { CAPABILITY_SHAPE, assertCapabilities, defineAdapter } from "../src/capabilities.mjs";

const noop = async () => ({ ok: true, changes: [], diagnostics: [] });

const base = (overrides = {}) => ({
  id: "example",
  displayName: "Example",
  capabilities: {},
  certification: { evidence: [] },
  detect: noop,
  install: noop,
  uninstall: noop,
  doctor: noop,
  normalizeHook: () => ({ kind: "sessionStart", sessionId: "s", cwd: "/tmp" }),
  renderContext: () => "",
  client: { command: "example", versionArgs: ["--version"] },
  ...overrides,
});

const evidence = capability => ({ evidence: [{
  client: "example", version: "1.0.0", platform: "darwin-arm64",
  observedAt: "2026-08-16", capability, fixture: "fixtures/example.json",
  provenance: "fixtures/certification-provenance.json", provenanceId: "example",
  idleBehavior: "observed while idle", busyBehavior: "observed while busy",
  authorityLevel: "advisory", limitations: [], result: "pass",
}] });

test("false is the default for every capability", () => {
  const adapter = defineAdapter(base());

  for (const [group, names] of Object.entries(CAPABILITY_SHAPE)) {
    for (const name of names) {
      assert.equal(adapter.capabilities[group][name], false,
        `${group}.${name} defaulted to something other than false`);
    }
  }
});

test("a true capability requires an implementation method", () => {
  assert.throws(() => defineAdapter(base({ capabilities: { guards: { beforeWrite: true } } })),
    /guardWrite/);
  assert.throws(() => defineAdapter(base({ capabilities: { lifecycle: { sessionEnd: true } } })),
    /endSession/);
});

test("a true capability is accepted once its method and evidence exist", () => {
  const adapter = defineAdapter(base({ capabilities: { guards: { beforeWrite: true } },
    certification: evidence("guards.beforeWrite"),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }) }));

  assert.equal(adapter.capabilities.guards.beforeWrite, true);
  assert.equal(adapter.capabilities.guards.beforeRead, false);
});

test("a client-driven heartbeat is a capability of its own, not next-turn delivery", () => {
  // Kimi Code fires SessionHeartbeat on a timer, so an idle session keeps its
  // presence fresh. The other three only reach a hook when the user takes a
  // turn, so an idle session there goes stale however alive it is. Presence in
  // this system is derived from a declared cadence, so the difference decides
  // whether a session can be trusted to say it is still there.
  assert.equal(CAPABILITY_SHAPE.lifecycle.includes("heartbeat"), true);

  assert.throws(() => defineAdapter(base({ capabilities: { lifecycle: { heartbeat: true } } })),
    /heartbeat\(\)/);

  const adapter = defineAdapter(base({ capabilities: { lifecycle: { heartbeat: true } },
    certification: evidence("lifecycle.heartbeat"),
    heartbeat: async () => ({ ok: true, changes: [], diagnostics: [] }) }));
  assert.equal(adapter.capabilities.lifecycle.heartbeat, true);
  assert.equal(adapter.capabilities.delivery.nextTurn, false,
    "heartbeat must not imply delivery; they are separately earned");
});

test("an unknown capability key or group fails validation", () => {
  assert.throws(() => assertCapabilities({ guards: { beforeThink: true } }, {}),
    error => error.code === EXIT.USAGE && error.message.includes("beforeThink"));
  assert.throws(() => assertCapabilities({ telepathy: { always: true } }, {}),
    error => error.code === EXIT.USAGE && error.message.includes("telepathy"));
});

test("a non-boolean capability value is rejected rather than coerced", () => {
  // "sometimes" must not become true. A capability is a promise the conformance
  // suite has to be able to check.
  assert.throws(() => assertCapabilities({ guards: { beforeWrite: "sometimes" } },
    { guardWrite: () => {} }), error => error.code === EXIT.USAGE);
});

test("the manifest is frozen, capabilities included", () => {
  const adapter = defineAdapter(base());

  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(adapter.capabilities), true);
  assert.equal(Object.isFrozen(adapter.capabilities.guards), true);
  assert.throws(() => { adapter.capabilities.guards.beforeWrite = true; }, TypeError);
});

test("an adapter must declare an id, a display name, and the base operations", () => {
  assert.throws(() => defineAdapter(base({ id: undefined })),
    error => error.code === EXIT.USAGE);
  assert.throws(() => defineAdapter(base({ id: "not a portable id" })),
    error => error.code === EXIT.DATA);
  for (const method of ["detect", "install", "uninstall", "doctor", "normalizeHook",
    "renderContext"]) {
    assert.throws(() => defineAdapter(base({ [method]: undefined })),
      error => error.code === EXIT.USAGE && error.message.includes(method),
      `a missing ${method} was accepted`);
  }
});

test("an adapter without a client binary is refused at construction", () => {
  // Detection spawns this to decide whether the client is on the machine. When
  // it was optional the probe fell back to the adapter id, so `claude_code` and
  // `gemini_cli` ran commands that exist nowhere and `acc install` reported
  // both absent on every machine while claiming success.
  const { client, ...withoutClient } = base();

  assert.throws(() => defineAdapter(withoutClient),
    error => error.code === EXIT.USAGE && /client\.command/.test(error.message));
  assert.throws(() => defineAdapter({ ...base(), client: { command: "  " } }),
    error => error.code === EXIT.USAGE);
});
