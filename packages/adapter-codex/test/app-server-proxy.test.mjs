import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initializeCodex, openCodexAppServer, probeCodexQueue, proxyCommand }
  from "../src/app-server-client.mjs";
import { startCodexDaemonServer } from "../../../tests/helpers/codex-daemon.mjs";

// Node cannot connect to an AF_UNIX socket on Windows, and the Codex daemon
// listens on one there. Measured on windows-latest with Codex 0.159.3 under a
// standard user: `codex app-server proxy` relays its stdio to the control
// socket, answers the WebSocket upgrade there, and a queued message reached
// the model. ACC speaks the same WebSocket JSON-RPC over the proxy's stdio.
const fakeProxy = fileURLToPath(new URL("../../../tests/helpers/fake-codex-proxy.mjs", import.meta.url));

test("windows: the app server is reached through the proxy's stdio", async t => {
  const dir = await mkdtemp(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "acc-px-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\acc-test-${randomBytes(8).toString("hex")}` : path.join(dir, "s.sock");
  const daemon = await startCodexDaemonServer({ socketPath, cwd: dir });
  t.after(async () => { await daemon.close(); await rm(dir, { recursive: true, force: true }); });
  const spawned = [];
  const spawnProxy = target => {
    spawned.push(target);
    return spawn(process.execPath, [fakeProxy, "app-server", "proxy", "--sock", target],
      { stdio: ["pipe", "pipe", "ignore"] });
  };
  const peer = openCodexAppServer({ socketPath, timeoutMs: 5_000, platform: "win32", spawnProxy });
  try {
    assert.equal(await initializeCodex(peer), "0.152.1");
  } finally {
    await peer.close();
  }
  const again = openCodexAppServer({ socketPath, timeoutMs: 5_000, platform: "win32", spawnProxy });
  try {
    assert.equal((await probeCodexQueue(again)).supported, true);
  } finally {
    await again.close();
  }
  assert.deepEqual(spawned, [socketPath, socketPath]);
});

// The daemon runs from the copy Codex installs under CODEX_HOME, so that copy
// is there whenever there is a daemon to reach, and it is an .exe: started
// without cmd.exe, whatever the socket path holds.
test("windows: the proxy is the managed codex.exe the daemon runs", () => {
  const socketPath = "C:\\Users\\Ann\\.codex\\app-server-control\\app-server-control.sock";
  assert.deepEqual(proxyCommand(socketPath), {
    file: "C:\\Users\\Ann\\.codex\\packages\\app-server-daemon\\current\\bin\\codex.exe",
    args: ["app-server", "proxy", "--sock", socketPath] });
});
