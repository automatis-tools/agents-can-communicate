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

// Outside ACC's blocks only by inspection: a selection line between markers.
const owned = source => source.split("# ACC native permissions end selection")[0];
const outside = source => source.replace(/# ACC native permissions begin (\w+)\n[\s\S]*?# ACC native permissions end \1\n/g, "");

test("a workspace selection of the user's own becomes ACC's equivalent one and comes back on removal", () => {
  for (const before of ['sandbox_mode = "workspace-write"\n', 'default_permissions = ":workspace"\n',
    'sandbox_mode = "workspace-write"\ndefault_permissions = ":workspace"\nmodel = "m"\n']) {
    const prepared = prepareLivePermissions(before, context);

    assert.equal(prepared.status.state, "configured", before);
    assert.match(owned(prepared.source), /^default_permissions = ":workspace"$/m, before);
    assert.doesNotMatch(outside(prepared.source), /^(sandbox_mode|default_permissions) = /m,
      "the profile must not depend on a selection outside ACC's blocks");
    assert.equal(prepareLivePermissions(prepared.source, context).source, prepared.source);
    assert.equal(removeLivePermissions(prepared.source).source, before);
  }
});

test("the setup note says which default ACC sets", () => {
  assert.match(outgoingStatus('model = "m"\n', context).setup,
    /sets default_permissions = ":workspace".*a defined profile needs a selection/);
  assert.match(outgoingStatus('sandbox_mode = "workspace-write"\n', context).setup,
    /keeps your workspace mode, written as default_permissions = ":workspace"/);
});

test("a config ACC set to its own profile moves back to the user's mode", () => {
  const before = 'model = "mine"\nsandbox_mode = "workspace-write"\n';
  const old = prepareLivePermissions(before, { ...context, clientVersion: "0.153.4" });
  assert.deepEqual(selection(old.source), ['default_permissions = "acc-workspace"']);

  const migrated = prepareLivePermissions(old.source, context);

  assert.deepEqual(selection(migrated.source), ['default_permissions = ":workspace"']);
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

// A mode that was the file's last line, with no newline, is restored before
// whatever Codex appended after ACC's blocks - its trust entries - on a line
// of its own.
test("a last-line mode without a newline is restored before what Codex appended later", () => {
  const before = 'model = "mine"\nsandbox_mode = "workspace-write"';
  const appended = '[hooks.state."acc:stop"]\ntrusted_hash = "sha256:abc"\n';
  for (const version of ["0.153.4", "0.164.0"]) {
    const trusted = prepareLivePermissions(before, { ...context, clientVersion: version }).source + appended;

    const migrated = prepareLivePermissions(trusted, context);

    assert.equal(migrated.status.state, "configured", version);
    assert.deepEqual(selection(migrated.source), ['default_permissions = ":workspace"']);
    assert.equal(removeLivePermissions(migrated.source).source, `${before}\n${appended}`);
  }
});
