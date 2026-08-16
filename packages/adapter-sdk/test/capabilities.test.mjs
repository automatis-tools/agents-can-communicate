import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { CAPABILITY_SHAPE, assertCapabilities, defineAdapter } from "../src/capabilities.mjs";

const noop = async () => ({ ok: true, changes: [], diagnostics: [] });

const base = (overrides = {}) => ({
  id: "example",
  displayName: "Example",
  capabilities: {},
  detect: noop,
  install: noop,
  uninstall: noop,
  doctor: noop,
  normalizeHook: () => ({ kind: "sessionStart", sessionId: "s", cwd: "/tmp" }),
  renderContext: () => "",
  ...overrides,
});

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

test("a true capability is accepted once its method exists", () => {
  const adapter = defineAdapter(base({ capabilities: { guards: { beforeWrite: true } },
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }) }));

  assert.equal(adapter.capabilities.guards.beforeWrite, true);
  assert.equal(adapter.capabilities.guards.beforeRead, false);
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
