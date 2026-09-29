import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createCodexMaintenance } from "../src/maintenance.mjs";
import { maintenanceContext } from "../src/maintenance-host.mjs";
import { createCodexDiscovery } from "../src/native-discovery.mjs";
import { maintenanceFixture } from "./maintenance-fixture.mjs";
import { serviceFixture } from "./service-setup-fixture.mjs";

// #205, measured on Codex 0.159.0 (2026-09-29): in a home with no standalone
// package, `codex app-server daemon start` installs the daemon's own package
// under packages/app-server-daemon, and records its PID in daemon.pid.

test("the service paths follow the package that is installed", async t => {
  const f = await maintenanceFixture(t, { binLayout: true });
  const standalone = await maintenanceContext(f.context);
  assert.equal(standalone.managedPath, f.managedPath);
  assert.equal(standalone.pidPath, f.pidPath);
  await f.selfInstalledLayout();
  const self = await maintenanceContext(f.context);
  assert.equal(self.managedPath, f.selfManagedPath);
  assert.equal(self.pidPath, f.selfPidPath);
});

test("a self-installed service is inspected as ready by its own identity", async t => {
  const f = await maintenanceFixture(t, { binLayout: true });
  await f.selfInstalledLayout();
  const snapshot = await createCodexMaintenance({ run: f.run, open: f.open }).inspectMaintenance(f.context);
  assert.equal(snapshot.reasonCode, null);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.managedPath, f.selfManagedPath);
  assert.equal(snapshot.pid, f.state.pid);
});

test("discovery proves a self-installed daemon and finds its chats", async t => {
  const f = await maintenanceFixture(t, { binLayout: true });
  await f.selfInstalledLayout();
  const project = path.join(f.root, "project");
  await mkdir(project);
  f.state.threads = [{ id: "thread-empty", cwd: project, parentThreadId: null, ephemeral: false,
    status: { type: "idle" } }];
  f.state.hooks = { [project]: ["sessionStart", "sessionEnd", "userPromptSubmit"].map(eventName =>
    ({ eventName, pluginId: "agents-can-communicate@acc-local", enabled: true, trustStatus: "trusted" })) };
  const found = await createCodexDiscovery({ run: f.run, open: f.open })
    .discoverNativeSessions({ env: f.context.env, home: f.context.home });
  assert.deepEqual(found.map(item => [item.sessionId, item.clientPid]), [["thread-empty", f.state.pid]]);
});

test("a new home on a CLI that installs its own service is started, not sent to a download", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  await f.selfInstalledLayout({ started: false });
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "needed");
  assert.equal(plan.reasonCode, "native_endpoint_unavailable");
  assert.equal(plan.requiresInstall, undefined, "no standalone download");
  assert.doesNotMatch(plan.diagnostic, /standalone|download/);
  const result = await f.prepareNativeServiceSetup({ context: f.context, plan });
  assert.equal(result.state, "ready", result.reasonCode);
  assert.equal(result.started, true);
  assert.equal(f.starts.length, 1);
  assert.equal(result.managedPath, f.selfManagedPath);
});

test("a new home on a CLI older than the self-installing one still needs the standalone package", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  await f.selfInstalledLayout({ started: false });
  f.state.cliVersion = f.state.managedVersion = f.state.serverVersion = "0.157.0";
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.reasonCode, "managed_install_missing");
  assert.equal(plan.requiresInstall, true);
});
