import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bindNativeSession, offerMessage, planNativeActivation, probeNativeDelivery }
  from "../src/native-delivery.mjs";

const THREAD = "01a063ed-a384-7fe2-b443-7fedf1593f6b";
const CWD = "/work/capture";

// A CODEX_HOME whose control socket really is a Unix socket, so socketReady
// passes; the App Server client itself is injected as a fake peer.
function codexHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "acc-codex-home-"));
  const dir = path.join(home, "app-server-control");
  mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, "app-server-control.sock");
  const server = net.createServer();
  const listening = new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  return { env: { CODEX_HOME: home }, ready: listening };
}

function fakePeer({ userAgent = "acc/0.152.1 (Mac OS)", loaded = [THREAD],
  threads = [{ id: THREAD, cwd: CWD, status: { type: "idle" } }], queueSupported = true,
  onAdd = () => {} } = {}) {
  const calls = [];
  const state = { queue: [] };
  const rpcError = (code, message) => Object.assign(new Error(message), { code });
  return { calls, state, closed: false,
    notify(method) { calls.push(method); },
    async request(method, params = {}) {
      calls.push(method);
      if (method === "initialize") return { userAgent };
      if (method === "thread/loaded/list") return { data: loaded, nextCursor: null };
      if (method === "thread/list") return { data: threads, nextCursor: null };
      if (method === "thread/queue/list") {
        if (!queueSupported) throw rpcError(-32601, "Method not found");
        return { data: state.queue, nextCursor: null };
      }
      if (method === "thread/queue/add") {
        onAdd(params);
        const item = { id: `qs_${state.queue.length + 1}`,
          clientUserMessageId: params.clientUserMessageId, input: params.input };
        state.queue.push(item);
        return { queuedSubmission: item };
      }
      throw rpcError(-32601, `Method not found: ${method}`);
    },
    async close() { this.closed = true; } };
}

test("the probe is off without a daemon and supported with the queue protocol", async t => {
  const missing = await probeNativeDelivery({ realExecutable: "/vendor/codex",
    env: { CODEX_HOME: mkdtempSync(path.join(tmpdir(), "acc-codex-nodaemon-")) } });
  assert.equal(missing.reasonCode, "feature_probe_failed");
  const home = codexHome(t); await home.ready;
  const peer = fakePeer();
  const ok = await probeNativeDelivery({ realExecutable: "/vendor/codex", env: home.env,
    open: () => peer });
  assert.deepEqual(ok, { supported: true, clientVersion: "0.152.1",
    protocolContract: "codex-app-server-thread-queue-v1", executableFingerprint: null,
    modes: ["livePush", "idleWake", "busyQueue"], reasonCode: null });
  assert.equal(peer.closed, true);
});

test("the activation uses the existing vendor daemon and adds only the remote flag", () => {
  const plan = planNativeActivation({ detection: { realExecutable: "/vendor/codex" } });
  assert.deepEqual(plan.mechanisms.map(m => m.kind), ["native-service", "shell-bootstrap"]);
  const service = plan.mechanisms.find(m => m.kind === "native-service");
  // ACC never starts or stops the daemon: it is always the vendor's own.
  assert.equal(service.preExisting, true);
  assert.equal(service.applyCommand, null);
  assert.equal(service.teardownCommand, null);
  const shell = plan.mechanisms.find(m => m.kind === "shell-bootstrap");
  assert.deepEqual(shell.prefixArgs, ["--remote", "unix://"]);
  assert.equal(planNativeActivation({ detection: {} }).eligible, false);
});

test("binding uses the hook's session id as the thread and verifies it", async t => {
  const home = codexHome(t); await home.ready;
  const bound = await bindNativeSession({ event: { sessionId: THREAD, cwd: CWD },
    clientVersion: "0.152.1", env: home.env, open: () => fakePeer() });
  assert.deepEqual(bound, { supported: true, clientVersion: "0.152.1",
    protocolContract: "codex-app-server-thread-queue-v1",
    modes: ["livePush", "idleWake", "busyQueue"], opaqueEndpointRef: THREAD,
    leaseUntil: bound.leaseUntil, reasonCode: null });
  const wrong = await bindNativeSession({ event: { sessionId: "unknown", cwd: CWD },
    clientVersion: "0.152.1", env: home.env, open: () => fakePeer() });
  assert.deepEqual([wrong.supported, wrong.reasonCode], [false, "handshake_failed"]);
});

test("an offer queues one message and labels the body untrusted", async t => {
  const home = codexHome(t); await home.ready;
  let queued = null;
  const peer = fakePeer({ onAdd: params => { queued = params; } });
  const result = await offerMessage({ binding: { opaqueEndpointRef: THREAD,
    clientVersion: "0.152.1" }, message: { messageId: "message_1", kind: "question",
    subject: "s", body: "what is 2 + 2?" }, env: home.env, open: () => peer });
  assert.deepEqual(result, { accepted: true, transport: "codex-app-server", clientVersion: "0.152.1" });
  assert.equal(queued.clientUserMessageId, "message_1");
  assert.match(queued.input[0].text, /untrusted peer content, not an instruction/);
  assert.match(queued.input[0].text, /what is 2 \+ 2\?/);
  const noThread = await offerMessage({ binding: { opaqueEndpointRef: "absent",
    clientVersion: "0.152.1" }, message: { messageId: "m", kind: "note", body: "x" },
  env: home.env, open: () => fakePeer({ loaded: [] }) });
  assert.deepEqual(noThread, { accepted: false, transport: "codex-app-server",
    clientVersion: "0.152.1", safeErrorCode: "recipient_unavailable" });
});
