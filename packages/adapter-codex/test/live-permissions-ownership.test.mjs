import assert from "node:assert/strict";
import test from "node:test";
import { prepareLivePermissions, removeLivePermissions } from "../src/live-permissions.mjs";

const context = { home: "/users/test", codexHome: "/users/test/.codex", stateRoot: "/users/test/data/acc",
  file: "/users/test/.codex/config.toml", requestedLivePolicy: "actionable", livePolicy: "off",
  clientVersion: "0.153.4", platform: "darwin-arm64" };

test("generated permissions preserve TOML scopes and restore raw bytes", () => {
  for (const before of [
    'model = "mine"',
    'model = "mine"\n[features]\nother = true',
    'default_permissions = ":workspace"\n[features]\nnetwork_proxy = false\n',
    'model = "mine"\r\n[features]\r\nother = true\r\n',
    'model_instructions = """\n# ACC native permissions begin selection\n[features]\nnetwork_proxy = false\n"""\n',
    '[features]\nother = true\n[sandbox_workspace_write]\n# my comment\nwritable_roots = ["/users/test/data/acc"]',
  ]) {
    const prepared = prepareLivePermissions(before, context);
    assert.equal(prepared.status.state, "configured", before);
    assert.equal(prepareLivePermissions(prepared.source, context).source, prepared.source);
    assert.equal(removeLivePermissions(prepared.source).source, before);
  }
});

test("edited, removed or newly referenced pieces preserve the whole dependent permission unit", () => {
  const source = prepareLivePermissions('model = "mine"\n[features]\nother = true\n', context).source;
  const variants = [
    source.replace("network_proxy = true", "network_proxy = false"),
    source.replace('extends = ":workspace"', 'extends = ":read-only"'),
    source.replace(/# ACC native permissions begin proxy\n[\s\S]*?# ACC native permissions end proxy\n/, ""),
    source + '[permissions.other]\nextends = "acc-workspace"\n',
  ];
  for (const edited of variants) {
    assert.equal(removeLivePermissions(edited).state, "customized");
    assert.equal(removeLivePermissions(edited).source, edited);
    assert.equal(prepareLivePermissions(edited, { ...context, requestedLivePolicy: "off" }).source, edited);
  }
});

test("custom legacy and inline policies remain user owned", () => {
  for (const before of [
    '[sandbox_workspace_write]\nwritable_roots = ["/users/test/data/acc", "/other"]\n',
    'features = { network_proxy = false }\n',
    'sandbox_mode = "read-only"\n',
    'permissions = { team = { extends = ":read-only" } }\n',
    'profile = "direct"\n[profiles.direct.features]\nnetwork_proxy = false\n',
    'profile = "restricted"\n[profiles.restricted]\nsandbox_mode = "read-only"\n',
  ]) {
    const prepared = prepareLivePermissions(before, context);
    assert.equal(prepared.status.state, "unverified");
    assert.equal(prepared.source, before);
  }
});

test("edited restoration metadata cannot insert settings on removal", () => {
  const source = prepareLivePermissions('model = "mine"\n', context).source;
  const edited = source.replace(/(# ACC native permissions restore )(.+)/, (_line, prefix, json) => {
    const records = JSON.parse(json);
    records.find(record => record.id === "proxy").before = 'network_proxy = false\n';
    return prefix + JSON.stringify(records);
  });
  assert.equal(removeLivePermissions(edited).state, "customized");
  assert.equal(removeLivePermissions(edited).source, edited);
});

test("foreign assignments under generated headers and escaped references retain their dependencies", () => {
  const source = prepareLivePermissions('model = "mine"\n', context).source;
  for (const edited of [
    source.replace("# ACC native permissions end proxy\n", "# ACC native permissions end proxy\nother_feature = true\n"),
    source + '[permissions.other]\nextends = "\\u0061cc-workspace"\n',
    source + '[profiles.other]\ndefault_permissions = "\\u0061cc-workspace"\n',
  ]) {
    assert.equal(removeLivePermissions(edited).state, "customized");
    assert.equal(removeLivePermissions(edited).source, edited);
  }
});

test("restoring legacy tables cannot reparent a new foreign assignment", () => {
  const before = '[features]\nother = true\n[sandbox_workspace_write]\n'
    + 'writable_roots = ["/users/test/data/acc"]\n[projects.foo]\ntrust_level = "trusted"\n';
  const source = prepareLivePermissions(before, context).source;
  const edited = source.replace("# ACC native permissions end legacy\n",
    "# ACC native permissions end legacy\nanother_feature = true\n");
  assert.equal(removeLivePermissions(edited).state, "customized");
  assert.equal(removeLivePermissions(edited).source, edited);
});

// ACC appends its profile block at end of file and then tells the user to trust
// ACC's hooks in Codex. Codex writes each trusted hook as a new `hooks.state`
// table, and those land above the appended block, changing the table that
// encloses it. Comparing that table unconditionally turned ACC's own documented
// setup step into `customized`: doctor reported working permissions as
// unverified, install refused to repair them, uninstall would not remove them.
test("a client writing new tables above the appended block keeps ACC's ownership", () => {
  const before = 'model = "mine"\n[features]\nother = true\n';
  const source = prepareLivePermissions(before, context).source;
  const trust = '[hooks.state."agents-can-communicate@acc-local:hooks.json:stop:0:0"]\n'
    + 'trusted_hash = "sha256:abc"\n';
  const marker = "# ACC native permissions begin profile";
  const edited = source.replace(marker, trust + marker);

  assert.notEqual(source.indexOf(marker), -1, "the profile block must exist to move");
  assert.equal(removeLivePermissions(edited).state, "owned");
  const restored = removeLivePermissions(edited).source;
  assert.doesNotMatch(restored, /ACC native permissions/);
  assert.match(restored, /agents-can-communicate@acc-local/);
  assert.equal(restored, before + trust);
});

// The relaxation is only sound for a block that opens with its own header. A
// block whose first declaration is a bare assignment belongs to whatever table
// precedes it, so moving it changes what the assignment configures.
test("a block opening with a bare assignment still depends on its enclosing table", () => {
  const source = prepareLivePermissions('model = "mine"\n[features]\nother = true\n', context).source;
  const proxy = "# ACC native permissions begin proxy";
  const body = source.slice(source.indexOf(proxy));
  assert.match(body.split("\n")[1], /^network_proxy = true$/,
    "this test is only meaningful while the proxy block opens with a bare assignment");

  const edited = source.replace(proxy, '[unrelated]\nkey = 1\n' + proxy);
  assert.equal(removeLivePermissions(edited).state, "customized");
  assert.equal(removeLivePermissions(edited).source, edited);
});
