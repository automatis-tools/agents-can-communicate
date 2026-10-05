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

// The proxy runs from the package the daemon runs from, found the way
// maintenance finds it: the standalone install when the home has one, else the
// copy `app-server daemon start` installs (measured on 0.159.3). Always an
// .exe, so it starts without cmd.exe whatever the socket path holds. Building
// the second path unconditionally left a home with only the standalone install
// unreachable (review of #243).
const HOME = "C:\\Users\\Ann\\.codex";
const SOCKET = `${HOME}\\app-server-control\\app-server-control.sock`;
const STANDALONE = `${HOME}\\packages\\standalone\\current\\bin\\codex.exe`;
const SELF_INSTALLED = `${HOME}\\packages\\app-server-daemon\\current\\bin\\codex.exe`;
const holding = (...files) => ({ exists: async file => files.includes(file) });

test("windows: the proxy runs from the standalone install when the home has one", async () => {
  assert.deepEqual(await proxyCommand(SOCKET, holding(STANDALONE, SELF_INSTALLED)),
    { file: STANDALONE, args: ["app-server", "proxy", "--sock", SOCKET] });
});

test("windows: without a standalone install the proxy is the daemon's own copy", async () => {
  assert.deepEqual(await proxyCommand(SOCKET, holding(SELF_INSTALLED)),
    { file: SELF_INSTALLED, args: ["app-server", "proxy", "--sock", SOCKET] });
});

test("windows: a home with neither has no proxy, and the connect fails without spawning",
  async () => {
    assert.equal(await proxyCommand(SOCKET, holding()), null);
    const peer = openCodexAppServer({ socketPath: SOCKET, timeoutMs: 2_000, platform: "win32",
      resolveProxy: socketPath => proxyCommand(socketPath, holding()) });
    try {
      await assert.rejects(initializeCodex(peer), /no codex\.exe/);
    } finally {
      await peer.close();
    }
  });
