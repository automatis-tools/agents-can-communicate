import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAccChannel, endpointDir } from "../src/channel.mjs";
import { bindNativeSession } from "../src/native-delivery.mjs";

/**
 * The handshake and the endpoint it looks for are started by the same event.
 *
 * SessionStart writes the session binding and then handshakes; the Channel is
 * waiting for exactly that binding before it can listen and register. So the
 * endpoint reliably appears *after* the handshake begins - measured on a real
 * 2.1.259 session, the registration landed while the hook had already given up,
 * and the session ran with no delivery binding at all even though the channel
 * was healthy and its endpoint file was on disk.
 *
 * `timeoutMs` was always plumbed through for this; it was simply discarded.
 */
const runtimeDirFor = t => {
  const root = mkdtempSync(path.join(tmpdir(), "acc-handshake-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const channelFor = async (t, root, clientPid) => {
  const channel = createAccChannel({ endpointDir: endpointDir(root), clientPid,
    write: () => {}, routeReply: async () => {}, routeAck: async () => {} });
  t.after(() => channel.close());
  await channel.listen();
  return channel;
};

test("the handshake waits within its budget for a channel that is still starting", async t => {
  const root = runtimeDirFor(t);
  const clientPid = 4242;
  const registered = new Promise(resolve => {
    setTimeout(() => { channelFor(t, root, clientPid).then(resolve, resolve); }, 150);
  });

  const bound = await bindNativeSession({ clientPid, clientVersion: "2.1.259",
    runtimeDir: root, timeoutMs: 750 });
  await registered;

  assert.equal(bound.supported, true,
    "the endpoint appeared inside the budget, so the session must end up bound");
  assert.equal(bound.reasonCode, null);
  assert.ok(bound.opaqueEndpointRef, "a bound handshake names the endpoint it resolved");
});

test("a budget that runs out still answers, rather than hanging the hook", async t => {
  const root = runtimeDirFor(t);
  const started = Date.now();

  const bound = await bindNativeSession({ clientPid: 4242, clientVersion: "2.1.259",
    runtimeDir: root, timeoutMs: 250 });

  assert.equal(bound.supported, false, "no channel ever registered for this pid");
  assert.equal(bound.reasonCode, "handshake_failed");
  assert.ok(Date.now() - started < 3_000,
    "the wait is bounded by the budget the hook is enforcing, not open-ended");
});

test("another session's channel is never adopted while waiting", async t => {
  const root = runtimeDirFor(t);
  await channelFor(t, root, 9999);

  const bound = await bindNativeSession({ clientPid: 4242, clientVersion: "2.1.259",
    runtimeDir: root, timeoutMs: 200 });

  assert.equal(bound.supported, false,
    "waiting must not relax the exact-pid rule; two sessions cannot share an endpoint");
});
