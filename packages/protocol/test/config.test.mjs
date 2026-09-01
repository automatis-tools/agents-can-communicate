import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "../src/errors.mjs";
import { CONFIG_FILENAME, CONFIG_SCHEMA_VERSION, defaultProjectConfig,
  validateProjectConfig } from "../src/config.mjs";

const valid = (overrides = {}) => ({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  workspaceId: "workspace_example",
  displayName: "Example",
  roots: ["."],
  policy: { claimMode: "advisory", contextBudgetBytes: 6000 },
  requiredAdapters: [],
  ...overrides,
});

test("a workspace with no config still has a complete policy", () => {
  const defaults = defaultProjectConfig();

  // Config is optional, so every value it can carry must have an answer
  // without it. A default that is undefined is a crash waiting for the first
  // team that never writes one.
  assert.equal(defaults.policy.claimMode, "advisory");
  assert.equal(Number.isInteger(defaults.policy.contextBudgetBytes), true);
  assert.deepEqual(defaults.roots, ["."]);
  assert.deepEqual(defaults.requiredAdapters, []);
  assert.equal(defaults.workspaceId, null, "an identity cannot be invented from nothing");
});

test("a valid config is accepted and frozen", () => {
  const config = validateProjectConfig(valid());

  assert.equal(config.workspaceId, "workspace_example");
  assert.equal(Object.isFrozen(config), true);
  assert.throws(() => { config.policy.claimMode = "guarded"; }, TypeError);
});

test("the workspace id is what makes identity stable across machines", () => {
  // Without it, identity falls back to the directory or the Git common dir, so
  // the same project checked out at two paths is two workspaces. This is the
  // one field a team writes the config for.
  const config = validateProjectConfig(valid({ workspaceId: "workspace_shared" }));
  assert.equal(config.workspaceId, "workspace_shared");

  assert.throws(() => validateProjectConfig(valid({ workspaceId: "not a portable id" })),
    error => error.code === EXIT.DATA);
});

test("multiple roots are declared relative to the config", () => {
  const config = validateProjectConfig(valid({ roots: [".", "packages/core", "apps/web"] }));

  assert.deepEqual([...config.roots], [".", "packages/core", "apps/web"]);
});

test("a root that leaves the workspace is refused", () => {
  // An absolute root is one machine's layout committed to a shared repository;
  // a `..` root reaches outside the boundary the workspace is meant to be.
  assert.throws(() => validateProjectConfig(valid({ roots: ["/srv/other"] })),
    error => error.code === EXIT.DATA);
  assert.throws(() => validateProjectConfig(valid({ roots: ["../sibling"] })),
    error => error.code === EXIT.DATA);
  assert.throws(() => validateProjectConfig(valid({ roots: ["packages/../../escape"] })),
    error => error.code === EXIT.DATA);
});

test("claim policy accepts only the two modes that exist", () => {
  assert.equal(validateProjectConfig(valid({
    policy: { claimMode: "guarded", contextBudgetBytes: 6000 } }))
    .policy.claimMode, "guarded");

  assert.throws(() => validateProjectConfig(valid({
    policy: { claimMode: "strict", contextBudgetBytes: 6000 } })),
    error => error.code === EXIT.DATA);
});

test("the context budget is bounded at both ends", () => {
  // Zero silently disables coordination context; a huge one spends the model's
  // window on a roster. Both are configuration mistakes worth naming.
  assert.throws(() => validateProjectConfig(valid({
    policy: { claimMode: "advisory", contextBudgetBytes: 0 } })),
    error => error.code === EXIT.DATA);
  assert.throws(() => validateProjectConfig(valid({
    policy: { claimMode: "advisory", contextBudgetBytes: 10_000_000 } })),
    error => error.code === EXIT.DATA);
  assert.throws(() => validateProjectConfig(valid({
    policy: { claimMode: "advisory", contextBudgetBytes: 1.5 } })),
    error => error.code === EXIT.DATA);
});

test("required adapters are named, so a missing one is a stated expectation", () => {
  const config = validateProjectConfig(valid({ requiredAdapters: ["codex", "kimi"] }));
  assert.deepEqual([...config.requiredAdapters], ["codex", "kimi"]);

  assert.throws(() => validateProjectConfig(valid({ requiredAdapters: ["not an id"] })),
    error => error.code === EXIT.DATA);
});

test("an unknown schema version is refused rather than read optimistically", () => {
  // A newer ACC may add meaning to fields this build would ignore, and ignoring
  // them silently is how a team's policy stops applying without anyone noticing.
  assert.throws(() => validateProjectConfig(valid({ schemaVersion: 2 })),
    error => error.code === EXIT.DATA);
  assert.throws(() => validateProjectConfig(valid({ schemaVersion: undefined })),
    error => error.code === EXIT.DATA);
});

test("runtime state is refused in a file that lives in the repository", () => {
  // Presence, messages, claims and credentials belong to the runtime directory.
  // A repository is the wrong place for them, and a config carrying them is
  // either a mistake or an attempt to inject state a peer would trust.
  for (const key of ["sessions", "participants", "messages", "claims", "receipts",
    "intents", "events", "deliveryBindings", "tokens", "credentials"]) {
    assert.throws(() => validateProjectConfig(valid({ [key]: [] })),
      error => error.code === EXIT.DATA && new RegExp(key).test(error.message),
      `${key} was accepted in a project config`);
  }
});

test("an unrecognised key is refused, but declared extensions are kept", () => {
  assert.throws(() => validateProjectConfig(valid({ clam_mode: "advisory" })),
    error => error.code === EXIT.DATA && /clam_mode/.test(error.message));

  // Forward compatibility has one door, and it is named.
  const config = validateProjectConfig(valid({ extensions: { vendor: { a: 1 } } }));
  assert.deepEqual(config.extensions, { vendor: { a: 1 } });
});

test("the config has one filename, so discovery is not a search", () => {
  assert.equal(CONFIG_FILENAME, "acc.workspace.json");
});

test("a non-object config is refused before any field is read", () => {
  for (const shape of [null, [], "text", 7]) {
    assert.throws(() => validateProjectConfig(shape), error => error.code === EXIT.DATA);
  }
});
