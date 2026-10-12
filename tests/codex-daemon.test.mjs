import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { startCodexDaemonServer } from "./helpers/codex-daemon.mjs";
import { posixTransportTest as test } from "./helpers/platform-scope.mjs";

// A client that connects but never sends its upgrade must not keep fixture
// teardown alive. Tracking only upgrade sockets leaves this connection behind.
test("daemon cleanup closes connections that have not upgraded", async t => {
  const root = await realpath(await mkdtemp("/tmp/acc-daemon-close-"));
  const socketPath = path.join(root, "daemon.sock");
  const daemon = await startCodexDaemonServer({ socketPath, cwd: root });
  const socket = net.connect(socketPath);
  let timer;
  t.after(async () => {
    clearTimeout(timer);
    socket.destroy();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });
  await once(socket, "connect");
  // Give the HTTP server its connection callback; no HTTP request is sent.
  await new Promise(resolve => setImmediate(resolve));
  const ended = once(socket, "close");
  const result = await Promise.race([
    daemon.close().then(() => "closed"),
    new Promise(resolve => { timer = setTimeout(resolve, 1000, "still connected"); }),
  ]);
  clearTimeout(timer);
  assert.equal(result, "closed", "an unupgraded socket held daemon.close open");
  await ended;
});
