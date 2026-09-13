import assert from "node:assert/strict";
import { chmod, lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createCodexServiceSetup } from "../src/service-setup.mjs";
import { serviceFixture } from "./service-setup-fixture.mjs";

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

test("unsupported platform and missing managed install provide action without start", async t => {
  const f = await serviceFixture(t);
  assert.equal((await f.inspectNativeServiceSetup({ ...f.context, platform: "linux-x64" })).state, "unsupported");
  await rm(f.managedPath);
  const result = await f.inspectNativeServiceSetup(f.context);
  assert.equal(result.state, "blocked");
  assert.match(result.diagnostic, /https:\/\/chatgpt.com\/codex\/install.sh/);
  assert.equal(f.starts.length, 0);
});

for (const entry of ["pid", "socket", "directory-symlink", "directory-writable"]) {
  test(`stale or unsafe ${entry} is not definite absence`, async t => {
    const f = await serviceFixture(t);
    if (entry === "pid") await f.writePid();
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
