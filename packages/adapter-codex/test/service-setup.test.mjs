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

// Node reports every Windows file as 0o666 and every directory as 0o777, so a
// mode test refuses every Codex home there (#445). Windows reads the ACLs: the
// three service directories and the two executables, in one read.
const USER_SID = "S-1-5-21-1-2-3-1001";
const privateAcl = { owner: USER_SID, ownerName: "HOST\\me", rules: [
  { sid: USER_SID, name: "HOST\\me", rights: 0x1f01ff, type: "Allow", inheritOnly: false },
  { sid: "S-1-5-18", name: "NT AUTHORITY\\SYSTEM", rights: 0x1f01ff, type: "Allow", inheritOnly: false },
  { sid: "S-1-5-32-545", name: "BUILTIN\\Users", rights: 0x1200a9, type: "Allow", inheritOnly: false }] };
function windowsSetup(f, aclOf) {
  const reads = [];
  const readAcls = async (files, options) => {
    reads.push({ files, env: options.env });
    return { user: aclOf.user === undefined ? USER_SID : aclOf.user,
      acls: new Map(files.map(file => [file, aclOf(file)])) };
  };
  return { reads, ...createCodexServiceSetup({ run: f.run, probe: f.probe, readAcls }) };
}
const windows = f => ({ ...f.context, platform: "win32-x64" });

test("on Windows the service is prepared by its access lists, whatever the mode bits say", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  await chmod(f.codexHome, 0o777);
  const setup = windowsSetup(f, () => privateAcl);
  const plan = await setup.inspectNativeServiceSetup(windows(f));
  assert.equal(plan.state, "needed", plan.diagnostic);
  assert.equal(plan.reasonCode, "native_endpoint_unavailable");
  const read = setup.reads.at(-1).files;
  assert.ok(read.includes(f.codexHome));
  assert.ok(read.includes(await realpath(f.cliPath)));
  assert.equal(read.length, 5, JSON.stringify(read));
  assert.equal(setup.reads.at(-1).env.CODEX_HOME, f.codexHome);
});

test("on Windows a service directory another account can write is refused by name", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  const open = { ...privateAcl, rules: [...privateAcl.rules,
    { sid: "S-1-5-32-545", name: "BUILTIN\\Users", rights: 0x2, type: "Allow", inheritOnly: false }] };
  const setup = windowsSetup(f, file => (file === f.codexHome ? open : privateAcl));
  const plan = await setup.inspectNativeServiceSetup(windows(f));
  assert.equal(plan.state, "blocked");
  assert.equal(plan.reasonCode, "unsafe_service_directory");
  assert.equal(plan.unsafePath, f.codexHome);
  assert.deepEqual(plan.unsafeWriters, ["BUILTIN\\Users (S-1-5-32-545)"]);
  assert.ok(plan.diagnostic.includes(f.codexHome), plan.diagnostic);
  assert.match(plan.diagnostic, /BUILTIN\\Users/);
  assert.equal(f.starts.length, 0);
});

test("on Windows an access list that cannot be read is refused, never trusted", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  const unreadable = () => null;
  const setup = windowsSetup(f, unreadable);
  const plan = await setup.inspectNativeServiceSetup(windows(f));
  assert.equal(plan.state, "blocked");
  assert.equal(plan.reasonCode, "unsafe_service_directory");
  assert.deepEqual(plan.unsafeWriters, ["unreadable"]);
  const noUser = Object.assign(() => privateAcl, { user: null });
  assert.equal((await windowsSetup(f, noUser).inspectNativeServiceSetup(windows(f))).reasonCode,
    "unsafe_service_directory");
});

test("a POSIX service directory others can write is refused with its path and mode", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  await chmod(f.codexHome, 0o777);
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "blocked");
  assert.equal(plan.reasonCode, "unsafe_service_directory");
  assert.equal(plan.unsafePath, f.codexHome);
  assert.deepEqual(plan.unsafeWriters, ["mode 777"]);
  assert.ok(plan.diagnostic.includes(f.codexHome), plan.diagnostic);
});

// Codex 0.165.0 and 0.172.0 install the Linux daemon executable with mode 0777
// (#446). ACC refuses it, names it, gives the command that closes it, and
// leaves the vendor's file as it is.
test("a daemon executable others can write is refused with the command that closes it", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  const managed = await realpath(f.managedPath);
  await chmod(managed, 0o777);
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "blocked");
  assert.equal(plan.reasonCode, "unsafe_service_executable");
  assert.equal(plan.unsafePath, managed);
  assert.deepEqual(plan.unsafeWriters, ["mode 777"]);
  assert.ok(plan.diagnostic.includes(`run chmod go-w "${managed}", then retry`), plan.diagnostic);
  assert.equal((await lstat(managed)).mode & 0o777, 0o777, "ACC must not change the vendor's file");
  await chmod(managed, 0o755);
  assert.equal((await f.inspectNativeServiceSetup(f.context)).state, "needed");
});

test("an owner that is not the user gets no chmod advice", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  const foreign = Object.assign(new Error("unsafe_service_directory"), { reasonCode: "unsafe_service_directory",
    unsafePath: f.codexHome, unsafeWriters: ["owner uid 0"] });
  const setup = createCodexServiceSetup({ run: f.run, probe: f.probe, readAcls: async () => { throw foreign; } });
  const plan = await setup.inspectNativeServiceSetup({ ...f.context, platform: "win32-x64" });
  assert.equal(plan.reasonCode, "unsafe_service_directory");
  assert.doesNotMatch(plan.diagnostic, /chmod/);
});

test("a service path of the wrong kind is refused with its path and kind", async t => {
  const f = await serviceFixture(t, { binLayout: true });
  const control = path.dirname(f.socketPath);
  await rm(control, { recursive: true, force: true });
  await writeFile(control, "not a directory");
  const plan = await f.inspectNativeServiceSetup(f.context);
  assert.equal(plan.state, "blocked");
  assert.equal(plan.reasonCode, "unsafe_service_directory");
  assert.equal(plan.unsafePath, control);
  assert.equal(plan.unsafeShape, "not a directory");
  assert.equal(plan.diagnostic, `The Codex service path ${control} is not a directory; inspect it, then retry acc install`);
});
