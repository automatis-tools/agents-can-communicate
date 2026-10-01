import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openCodexAppServer } from "../src/app-server-client.mjs";
import { probeNativeDelivery } from "../src/native-delivery.mjs";
import { newEndpointId, readNativeEndpoint, readySocketPath, socketIsReady, writeNativeEndpoint }
  from "../src/native-endpoint.mjs";
import { controlledCodexDaemon } from "../../../tests/helpers/codex-daemon.mjs";

// Measured on windows-latest with Codex 0.159.3: Node's lstat refuses the
// daemon's AF_UNIX socket file with EACCES, so on Windows the socket counts
// while its directory lists it; Codex keeps that directory to its user.
test("windows: the control socket counts while its directory lists it", async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cx-win-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const control = path.join(home, "app-server-control");
  await mkdir(control);
  const socketPath = path.join(control, "app-server-control.sock");
  assert.equal(await socketIsReady(socketPath, { platform: "win32" }), false);
  await writeFile(path.join(control, "App-Server-Control.sock"), "");
  assert.equal(await socketIsReady(socketPath, { platform: "win32" }), true, "names compare without case");
  assert.equal(await readySocketPath(socketPath, { platform: "win32" }), socketPath);
  assert.equal(await readySocketPath(path.join(home, "missing", "app-server-control.sock"),
    { platform: "win32" }), null);
});

test("windows: endpoint records are read where every file reports mode 0o666", async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cx-win-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const control = path.join(home, "app-server-control");
  await mkdir(control);
  const socketPath = path.join(control, "app-server-control.sock");
  await writeFile(socketPath, "");
  const runtimeDir = path.join(home, "runtime");
  const record = { schemaVersion: 1, endpointId: newEndpointId(), socketPath, threadId: "thread-1",
    cwd: home, clientVersion: "0.159.3", protocolContract: "codex-app-server-thread-queue-v1",
    leaseUntil: new Date(Date.now() + 60_000).toISOString() };
  await writeNativeEndpoint({ runtimeDir, record, platform: "win32" });
  const dir = path.join(runtimeDir, "codex-native-endpoints");
  await chmod(dir, 0o777);
  for (const name of await readdir(dir)) await chmod(path.join(dir, name), 0o666);
  const read = await readNativeEndpoint({ runtimeDir, endpointId: record.endpointId, platform: "win32" });
  assert.equal(read?.socketPath, socketPath);
});

const fakeProxy = fileURLToPath(new URL("../../../tests/helpers/fake-codex-proxy.mjs", import.meta.url));

test("windows: the probe reaches the daemon through the proxy", async t => {
  const daemon = await controlledCodexDaemon(t, { cwd: tmpdir() });
  const open = options => openCodexAppServer({ ...options, platform: "win32",
    spawnProxy: target => spawn(process.execPath, [fakeProxy, "app-server", "proxy", "--sock", target],
      { stdio: ["pipe", "pipe", "ignore"] }) });
  const probe = await probeNativeDelivery({ env: daemon.env, platform: "win32", open, timeoutMs: 5_000 });
  assert.equal(probe.supported, true, probe.reasonCode);
});
