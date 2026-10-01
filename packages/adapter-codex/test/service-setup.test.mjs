import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import nodeTest from "node:test";
import { createCodexServiceSetup } from "../src/service-setup.mjs";
import { serviceFixture } from "./service-setup-fixture.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

const apply = (f, plan, context = f.context) => f.prepareNativeServiceSetup({ context, plan });

test("definite absence starts the pinned executable once with exact homes and verifies metadata protocol", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "needed");
  assert.equal(f.starts.length, 0);
  const result = await apply(f, plan);
  assert.equal(result.state, "ready");
  assert.equal(result.started, true);
  assert.equal(result.reasonCode, "native_session_unavailable");
  assert.match(result.diagnostic, /new Codex session/);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].command, f.cliPath);
  assert.deepEqual(f.starts[0].args, ["app-server", "daemon", "start"]);
  assert.ok(f.requests.includes("initialize"));
  assert.ok(f.requests.includes("thread/loaded/list"));
  assert.ok((await lstat(f.socketPath)).isSocket());
});

// Service preparation was captured on darwin-arm64; a host the captures never
// named is inspected and, on definite absence, started the same way.
test("a missing service is prepared the same way on a platform the captures never named", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  const context = { ...f.context, platform: "linux-x64" };
  const plan = await f.inspectNativeServiceSetup(context);
  assert.equal(plan.state, "needed");
  assert.equal(plan.reasonCode, "native_endpoint_unavailable");
  const result = await apply(f, plan, context);
  assert.equal(result.state, "ready");
  assert.equal(result.started, true);
  assert.equal(f.starts.length, 1);
});

test("a healthy empty service and a healthy raced service start zero times", async t => {
  const f = await serviceFixture(t);
  const absent = await f.inspectNativeServiceSetup(f.context);
  await f.start();
  const raced = await apply(f, absent);
  assert.equal(raced.state, "ready");
  assert.equal(raced.started, false);
  const ready = await f.inspectNativeServiceSetup(f.context);
  assert.equal(ready.state, "ready");
  assert.equal((await apply(f, ready)).state, "ready");
  assert.equal(f.starts.length, 0);
});

test("older healthy native delivery needs no new cold-start prerequisite or upgrade", async t => {
  const f = await serviceFixture(t, { missing: false });
  f.state.cliVersion = f.state.managedVersion = f.state.serverVersion = "0.152.1";
  f.state.threads = [{ id: "existing-thread" }];
  await rm(f.managedPath);
  const ready = await f.inspectNativeServiceSetup(f.context);
  assert.equal(ready.state, "ready");
  assert.equal(ready.reasonCode, null,
    "a loaded service must not be diagnosed as missing a session");
  assert.doesNotMatch(ready.diagnostic, /upgrade|update|install.sh/);
  assert.equal((await apply(f, ready)).state, "ready");
  assert.equal(f.starts.length, 0);
});

for (const [field, value, reason] of [
  ["cliVersion", "0.153.4", "maintenance_cli_unsupported"],
  ["managedVersion", "0.153.4", "managed_binary_mismatch"],
]) test(`${reason} blocks cold preparation`, async t => {
  const f = await serviceFixture(t); f.state[field] = value;
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.reasonCode, reason);
  assert.equal((await apply(f, plan)).started, false);
  assert.equal(f.starts.length, 0);
});

test("an incomplete managed install provides action without start", async t => {
  const f = await serviceFixture(t);
  await rm(f.managedPath);
  const result = await f.inspectNativeServiceSetup(f.context);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "managed_install_incomplete");
  assert.match(result.diagnostic, /official Codex installer/);
  assert.equal(f.starts.length, 0);
});

// A pid record naming a process nobody can observe is not a stopped service:
// the process may be alive under another user, and ACC never starts over it.
for (const entry of ["unobservable-pid", "socket", "directory-symlink", "directory-writable"]) {
  test(`an unobservable pid or an unsafe ${entry === "unobservable-pid" ? "record" : entry} is not definite absence`, async t => {
    const f = await serviceFixture(t);
    if (entry === "unobservable-pid") { await f.writePid(); f.state.processUnknown = true; }
    if (entry === "socket") await writeFile(f.socketPath, "stale");
    const directory = path.dirname(f.socketPath);
    if (entry === "directory-symlink") {
      await rm(directory, { recursive: true });
      const elsewhere = path.join(f.root, "elsewhere"); await mkdir(elsewhere);
      await symlink(elsewhere, directory);
    }
    if (entry === "directory-writable") await chmod(directory, 0o777);
    const plan = await f.inspectNativeServiceSetup(f.context);
    assert.equal(plan.state, "blocked");
    assert.equal((await apply(f, plan)).started, false);
    assert.equal(f.starts.length, 0);
  });
}

test("lstat permission errors are unknown, never absence", async t => {
  const f = await serviceFixture(t);
  const adapter = createCodexServiceSetup({ run: f.run, probe: f.probe,
    fs: { realpath, lstat: async file => {
      if (file === f.pidPath) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return lstat(file);
    } } });
  assert.equal((await adapter.inspectNativeServiceSetup(f.context)).state, "blocked");
  assert.equal(f.starts.length, 0);
});

for (const change of ["home", "codex-home", "executable", "managed-current"]) {
  test(`changed ${change} invalidates the pinned plan`, async t => {
    const f = await serviceFixture(t);
    const plan = await f.inspectNativeServiceSetup(f.context);
    let context = f.context;
    if (change === "home") context = { ...context, home: path.join(f.root, "other-home") };
    if (change === "codex-home") context = { ...context, env: { ...context.env, CODEX_HOME: path.join(f.root, "other-codex") } };
    if (change === "executable") await writeFile(f.cliPath, "different executable");
    if (change === "managed-current") await writeFile(f.managedPath, "different managed executable");
    const result = await apply(f, plan, context);
    assert.equal(result.state, "blocked");
    assert.equal(result.started, false);
    assert.equal(f.starts.length, 0);
  });
}

for (const failure of ["startFails", "startThrows", "protocolFails", "socketOwned", "processUnknown", "backend"]) {
  test(`${failure} cannot report a verified start`, async t => {
    const f = await serviceFixture(t);
    const plan = await f.inspectNativeServiceSetup(f.context);
    f.state[failure] = failure === "socketOwned" ? false : failure === "backend" ? "launchd" : true;
    const result = await apply(f, plan);
    assert.equal(result.state, "failed");
    assert.equal(result.started, true);
    assert.equal(f.starts.length, 1);
    assert.doesNotMatch(result.diagnostic, /private failure/);
  });
}

// What a service killed without cleanup leaves: the socket file, and nothing
// accepting on it. A graceful close unlinks the file, so the listener is killed.
async function leaveStaleSocket(socketPath) {
  const listener = spawn(process.execPath, ["-e", "require('node:net').createServer()"
    + `.listen(${JSON.stringify(socketPath)}, () => process.stdout.write('up'))`]);
  await once(listener.stdout, "data");
  listener.kill("SIGKILL");
  await once(listener, "exit");
  assert.equal((await lstat(socketPath)).isSocket(), true);
}

const unix = { skip: process.platform === "win32" && "Unix domain socket files" };

// Measured on Codex 0.155.1: its own `app-server daemon start` replaces both
// files a stopped service leaves, so a stopped service is prepared like an
// absent one - by that command, with every identity check after it.
for (const leftovers of [["socket"], ["socket", "pid"], ["pid"]]) {
  test(`a stopped service's leftover ${leftovers.join(" and ")} is started once, in place`,
    unix, async t => {
      const f = await serviceFixture(t);
      if (leftovers.includes("socket")) await leaveStaleSocket(f.socketPath);
      if (leftovers.includes("pid")) await f.writePid();
      const plan = await f.inspectNativeServiceSetup(f.context);
      assert.equal(plan.state, "needed");
      assert.equal(plan.reasonCode, "service_stopped");
      assert.match(plan.diagnostic, /acc install/);
      const result = await apply(f, plan);
      assert.equal(result.state, "ready");
      assert.equal(result.started, true);
      assert.equal(f.starts.length, 1);
      assert.ok((await lstat(f.socketPath)).isSocket());
    });
}

const notStopped = async (f, t) => {
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.notEqual(plan.reasonCode, "service_stopped");
  assert.equal(f.starts.length, 0);
};

test("a leftover socket beside the pid of a live process is not a stopped service", unix, async t => {
  const f = await serviceFixture(t);
  await leaveStaleSocket(f.socketPath);
  await f.writePid();
  f.state.running = true;
  await notStopped(f, t);
});

test("an unsafe pid file beside a leftover socket is not a stopped service", unix, async t => {
  const f = await serviceFixture(t);
  await leaveStaleSocket(f.socketPath);
  await f.writePid();
  await chmod(f.pidPath, 0o666);
  await notStopped(f, t);
});

test("a socket that still accepts, with no pid file, is not a stopped service", async t => {
  const f = await serviceFixture(t, { missing: false });
  await rm(f.pidPath);
  await notStopped(f, t);
});

test("a socket that fails to connect for another reason is not a stopped service", unix, async t => {
  const f = await serviceFixture(t, { missing: false });
  await rm(f.pidPath);
  await chmod(f.socketPath, 0o000); // connect is refused permission, not the connection
  await notStopped(f, t);
});

// Codex 0.157.1 keeps the control socket behind a symlink, so a symlink is
// the ordinary shape of a running service, and what a stopped one leaves.
test("a 0.157.1 service is ready through its symlinked socket", unix, async t => {
  const f = await serviceFixture(t);
  await f.daemonLayout157();
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "ready", plan.reasonCode);
  assert.equal(f.starts.length, 0);
});

for (const leftover of ["dangling", "refusing"]) {
  test(`a stopped 0.157.1 service, its symlink ${leftover}, is started once in place`, unix, async t => {
    const f = await serviceFixture(t);
    await f.daemonLayout157();
    await f.stop();
    if (leftover === "refusing") await leaveStaleSocket(f.state.listenPath);
    await f.writePid();
    assert.equal((await lstat(f.socketPath)).isSymbolicLink(), true);
    const plan = await f.inspectNativeServiceSetup(f.context);
    assert.equal(plan.state, "needed", plan.reasonCode);
    assert.equal(plan.reasonCode, "service_stopped");
    const result = await apply(f, plan);
    assert.equal(result.state, "ready", result.reasonCode);
    assert.equal(f.starts.length, 1);
  });
}

test("a symlink to a regular file is not a stopped service", async t => {
  const f = await serviceFixture(t);
  const elsewhere = path.join(f.root, "elsewhere");
  await writeFile(elsewhere, "not a socket");
  await symlink(elsewhere, f.socketPath);
  await notStopped(f, t);
});

test("a regular file where the socket belongs is not a stopped service", async t => {
  const f = await serviceFixture(t);
  await writeFile(f.socketPath, "not a socket");
  await notStopped(f, t);
});

test("a ready service that disappears becomes blocked without inventing cold-start consent", async t => {
  const f = await serviceFixture(t, { missing: false });
  const plan = await f.inspectNativeServiceSetup(f.context);
  await f.stop();
  const result = await apply(f, plan);
  assert.equal(result.state, "blocked");
  assert.equal(result.started, false);
  assert.equal(f.starts.length, 0);
});

for (const loadedData of [[null], [123], [{}], [""], ["valid-thread", null]]) {
  test(`malformed loaded-thread metadata ${JSON.stringify(loadedData)} fails preparation after start`, async t => {
    const f = await serviceFixture(t);
    const plan = await f.inspectNativeServiceSetup(f.context);
    assert.equal(plan.state, "needed");
    f.state.loadedData = loadedData;
    const result = await apply(f, plan);
    assert.equal(result.state, "failed");
    assert.equal(result.reasonCode, "daemon_protocol_unverified");
    assert.equal(result.started, true);
    assert.equal(f.starts.length, 1);
    assert.ok(f.requests.includes("initialize"));
    assert.ok(f.requests.includes("thread/loaded/list"));
    assert.equal(f.requests.includes("thread/queue/list"), false);
  });
}

// Measured 2026-09-29 on 0.158.0: after a reboot no daemon runs, and the next
// TUI starts one itself because `daemon_auto_start` is on (the default since
// 0.157.1). Doctor must not send the operator to `acc install` for that.
const features = enabled => "apps                                     stable             true\n"
  + `daemon_auto_start                        stable             ${enabled}\n`
  + "hooks                                    stable             true\n";

test("an absent service that Codex starts at launch says so", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  f.state.featuresList = features(true);
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "needed");
  assert.equal(plan.reasonCode, "native_endpoint_unavailable");
  assert.equal(plan.startsOnLaunch, true);
  assert.match(plan.diagnostic, /starts .*with the next Codex session/);
  // An explicit install with setup consent still starts it at once.
  const result = await apply(f, plan);
  assert.equal(result.state, "ready");
  assert.equal(f.starts.length, 1);
});

test("an absent service is left to acc install when Codex does not start it at launch", async t => {
  for (const featuresList of [features(false), "apps  stable  true\n", undefined]) {
    const f = await serviceFixture(t, { binLayout: true });
    f.state.featuresList = featuresList;
    const plan = await f.inspectNativeServiceSetup(f.context);
    assert.equal(plan.state, "needed");
    assert.equal(plan.startsOnLaunch, undefined);
    assert.doesNotMatch(plan.diagnostic, /next Codex session/);
  }
});

test("a stopped service that Codex starts at launch says so too", async t => {
  const f = await serviceFixture(t);
  await f.writePid();
  f.state.featuresList = features(true);
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.reasonCode, "service_stopped");
  assert.equal(plan.startsOnLaunch, true);
  assert.match(plan.diagnostic, /next Codex session/);
});
