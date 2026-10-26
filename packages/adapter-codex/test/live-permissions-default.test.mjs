import assert from "node:assert/strict";
import test from "node:test";
import { outgoingStatus, prepareLivePermissions, removeLivePermissions } from "../src/live-permissions.mjs";

// Codex 0.164.0 runs a command ACC's rules file allows outside the sandbox on its
// own, so ACC's commands no longer need ACC's profile selected. The profile stays
// defined, for a chat that picks it, and new chats keep their usual mode.
const context = { home: "/users/test", codexHome: "/users/test/.codex", stateRoot: "/users/test/data/acc",
  file: "/users/test/.codex/config.toml", requestedLivePolicy: "actionable", livePolicy: "off",
  clientVersion: "0.164.0", platform: "darwin-arm64", ruleAllowsCommands: true };
const selection = source => source.match(/^default_permissions = .*$/gm) ?? [];

test("a config that selects nothing gets Codex's workspace mode, with ACC's profile available", () => {
  const prepared = prepareLivePermissions('model = "mine"\n', context);

  assert.deepEqual(selection(prepared.source), ['default_permissions = ":workspace"']);
  assert.match(prepared.source, /^\[permissions\.acc-workspace\]$/m);
  assert.match(prepared.source, /^network_proxy = true$/m);
  assert.equal(prepared.status.state, "configured");
  assert.equal(prepareLivePermissions(prepared.source, context).source, prepared.source);
  assert.equal(removeLivePermissions(prepared.source).source, 'model = "mine"\n');
});

test("a selection of the user's own is kept as it is", () => {
  for (const before of ['sandbox_mode = "workspace-write"\n', 'default_permissions = ":workspace"\n']) {
    const prepared = prepareLivePermissions(before, context);

    assert.ok(prepared.source.includes(before.trim()), prepared.source);
    assert.equal(selection(prepared.source).filter(line => line.includes("acc-workspace")).length, 0);
    assert.equal((prepared.source.match(/^(sandbox_mode|default_permissions) = /gm) ?? []).length, 1);
    assert.equal(prepared.status.state, "configured");
    assert.equal(removeLivePermissions(prepared.source).source, before);
  }
});

test("a config ACC set to its own profile moves back to the user's mode", () => {
  const before = 'model = "mine"\nsandbox_mode = "workspace-write"\n';
  const old = prepareLivePermissions(before, { ...context, clientVersion: "0.153.4" });
  assert.deepEqual(selection(old.source), ['default_permissions = "acc-workspace"']);

  const migrated = prepareLivePermissions(old.source, context);

  assert.equal(selection(migrated.source).length, 0);
  assert.match(migrated.source, /^sandbox_mode = "workspace-write"$/m);
  assert.match(migrated.source, /^\[permissions\.acc-workspace\]$/m);
  assert.equal(migrated.status.state, "configured");
  assert.equal(removeLivePermissions(migrated.source).source, before);
});

test("where the rule cannot carry ACC's commands, ACC's profile is still selected", () => {
  for (const changed of [{ ruleAllowsCommands: false }, { clientVersion: "0.163.0" }]) {
    const prepared = prepareLivePermissions('model = "mine"\n', { ...context, ...changed });

    assert.deepEqual(selection(prepared.source), ['default_permissions = "acc-workspace"'], JSON.stringify(changed));
    assert.equal(prepared.status.state, "configured");
  }
});

test("doctor reports the profile as available, not selected, once the rule carries the commands", () => {
  const prepared = prepareLivePermissions('model = "mine"\n', context);
  const status = outgoingStatus(prepared.source, context);

  assert.equal(status.reasonCode, null);
  assert.match(status.diagnostic, /rules file/);
  assert.match(status.diagnostic, /acc-workspace/);
});
