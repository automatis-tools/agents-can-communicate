import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCodexAdapter } from "../src/adapter.mjs";
import { applyPlan, detectInstallation, planInstallation } from "@agents-can-communicate/installer";

async function fixture(t, before = "") {
  const home = await mkdtemp(path.join(tmpdir(), "acc-codex-permissions-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, ".codex");
  await mkdir(codexHome);
  const file = path.join(codexHome, "config.toml");
  await writeFile(file, before);
  const context = { home, codexHome, dataHome: path.join(home, "data"),
    stateRoot: path.join(home, "data", "acc"), node: process.execPath,
    runner: fileURLToPath(new URL("../../../bin/acc-hook.mjs", import.meta.url)),
    cli: fileURLToPath(new URL("../../../bin/acc.mjs", import.meta.url)),
    clientVersion: "0.153.4", platform: "darwin-arm64", requestedLivePolicy: "actionable",
    livePolicy: "off", env: {} };
  return { context, file, read: () => readFile(file, "utf8"), adapter: createCodexAdapter() };
}

test("consent configures outbound permissions even before the daemon is available", async t => {
  const f = await fixture(t, 'model = "user-model"\n[features]\nother_feature = true\n');
  await f.adapter.install(f.context);
  const source = await f.read();
  assert.match(source, /^default_permissions = "acc-workspace"$/m);
  assert.match(source, /^network_proxy = true$/m);
  assert.equal((source.match(/^\[features\]$/gm) ?? []).length, 1);
  assert.match(source, /^\[permissions\.acc-workspace\]$/m);
  assert.match(source, /^extends = ":workspace"$/m);
  assert.ok(source.includes(`${JSON.stringify(f.context.stateRoot)} = "write"`));
  assert.ok(source.includes(`${JSON.stringify(path.join(f.context.codexHome,
    "app-server-control", "app-server-control.sock"))} = "allow"`));
  assert.doesNotMatch(source, /^\[sandbox_workspace_write\]$/m);
  assert.match(source, /model = "user-model"/);
  assert.match(source, /other_feature = true/);
});

test("reinstall is stable and uninstall restores pre-existing default configuration", async t => {
  const before = '# user preference\nmodel = "user-model"\n[features]\nnetwork_proxy = false\nother_feature = true\n';
  const f = await fixture(t, before);
  await f.adapter.install(f.context);
  const first = await f.read();
  assert.match(first, /default_permissions = "acc-workspace"/);
  await f.adapter.install(f.context);
  assert.equal(await f.read(), first);
  await f.adapter.uninstall(f.context);
  assert.equal(await f.read(), before);
});

test("explicit off restores the previous policy without leaving proxy or profile grants", async t => {
  const f = await fixture(t);
  await f.adapter.install(f.context);
  assert.match(await f.read(), /default_permissions = "acc-workspace"/);
  await f.adapter.install({ ...f.context, requestedLivePolicy: "off", livePolicy: "off" });
  assert.doesNotMatch(await f.read(), /default_permissions|network_proxy|permissions\.acc-workspace/);
  assert.match(await f.read(), /\[sandbox_workspace_write\]/);
});

test("an ACC-only legacy sandbox is migrated and restored without losing its bytes", async t => {
  const f = await fixture(t);
  const before = 'sandbox_mode = "workspace-write"\n[features]\nother_feature = true\n'
    + `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(f.context.stateRoot)}]\n`;
  await writeFile(f.file, before);
  await f.adapter.install(f.context);
  assert.doesNotMatch(await f.read(), /^sandbox_mode\s*=|^\[sandbox_workspace_write\]/m);
  assert.match(await f.read(), /default_permissions = "acc-workspace"/);
  await f.adapter.uninstall(f.context);
  assert.equal(await f.read(), before);
});

test("custom permission profiles are preserved and do not acquire an incompatible legacy sandbox", async t => {
  const before = 'default_permissions = "team"\n[permissions.team]\nextends = ":workspace"\n'
    + '[permissions.team.filesystem]\n"/secrets" = "deny"\n';
  const f = await fixture(t, before);
  const installed = await f.adapter.install(f.context);
  assert.ok((await f.read()).startsWith(before));
  assert.doesNotMatch(await f.read(), /sandbox_workspace_write|permissions\.acc-workspace/);
  assert.ok(installed.needsAction.some(line => /outgoing|outbound/i.test(line)
    && line.includes(f.file)), "the operator must see that outgoing access is still unverified");
  await f.adapter.uninstall(f.context);
  assert.equal(await f.read(), before);
});

test("customized generated permissions retain their proxy and selection on uninstall", async t => {
  const f = await fixture(t);
  await f.adapter.install(f.context);
  const original = await f.read();
  assert.match(original, /extends = ":workspace"/);
  await writeFile(f.file, original.replace('extends = ":workspace"',
    'extends = ":workspace"\ndescription = "user customization"'));
  const result = await f.adapter.uninstall(f.context);
  const retained = await f.read();
  assert.match(retained, /default_permissions = "acc-workspace"/);
  assert.match(retained, /network_proxy = true/);
  assert.match(retained, /user customization/);
  assert.ok(result.diagnostics.some(line => /kept|preserved/.test(line) && /permission/.test(line)));
});

test("unknown or uncaptured clients do not receive unverified security settings", async t => {
  for (const change of [{ clientVersion: null }, { clientVersion: "0.152.1" }, { platform: "linux-x64" }]) {
    const f = await fixture(t);
    const result = await f.adapter.install({ ...f.context, ...change });
    assert.doesNotMatch(await f.read(), /default_permissions|network_proxy/);
    assert.ok(result.needsAction.some(line => /outgoing|outbound/.test(line)));
  }
});

test("detected version and platform reach applied permissions and subsequent diagnosis", async t => {
  const f = await fixture(t);
  const { clientVersion: _version, platform: _platform, ...context } = f.context;
  const detect = () => detectInstallation({ adapters: [f.adapter], context,
    platform: "darwin-arm64", pathEnv: "", probe: async () => "codex-cli 0.153.4" });
  const detected = await detect();
  const plan = planInstallation({ adapters: [f.adapter], context, detected,
    deliveryByAdapter: { codex: "actionable" } });
  const result = await applyPlan({ adapters: [f.adapter], context, plan, dataHome: context.dataHome });
  assert.deepEqual(result.failed, []);
  assert.match(await f.read(), /default_permissions = "acc-workspace"/);
  const after = await detect();
  assert.equal(after[0].outgoingDelivery.state, "configured");
});
