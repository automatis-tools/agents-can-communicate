import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MINIMUM_VERSION, PROTOCOL_CONTRACT, addCodexQueueMessage, compareStableVersions,
  discoverCodexThreads, evaluateClientVersion, isMethodMissing, locateCodexThread,
  probeCodexQueue, runCodexQueueCapture, serverVersionOf }
  from "../../scripts/spikes/codex-existing-session.mjs";
import { runProcess } from "../helpers/claude-channel.mjs";

// Kept cohesive above 300 lines because every case drives the same disposable
// queue probe against one fake App Server; splitting would duplicate the peer.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const captureScript = path.join(repoRoot, "scripts", "spikes", "codex-existing-session.mjs");
const THREAD = "thread-native-capture";
const CWD = "/work/capture";
const SECRET_PREVIEW = "SECRET-PREVIEW-4d2c must never surface";

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

const OBSERVED_USER_AGENT = "acc-native-delivery-capture/0.152.1 (Mac OS 26.6.2; arm64) "
  + "Apple_Terminal (acc-native-delivery-capture; 0.0.0)";

function fakePeer({ userAgent = OBSERVED_USER_AGENT,
  loaded = [THREAD], threads = [thread(THREAD, CWD)], queueSupported = true,
  queue = [], transportError = null, missingMethodCode = -32601 } = {}) {
  const methodMissing = (method) => missingMethodCode === -32601
    ? rpcError(-32601, "Method not found")
    : rpcError(-32600, `Invalid request: unknown variant \`${method}\`, expected one of ...`);
  const calls = [];
  const state = { queue: queue.map(item => ({ ...item })) };
  return {
    calls, state, notifications: [],
    notify(method, params) { calls.push({ method, params, notification: true }); },
    async request(method, params) {
      calls.push({ method, params });
      if (transportError) throw transportError;
      switch (method) {
        case "initialize":
          return { userAgent, codexHome: "/home/x/.codex", platformFamily: "unix",
            platformOs: "macos" };
        case "thread/loaded/list": return { data: loaded, nextCursor: null };
        case "thread/list":
          if (params.useStateDbOnly !== true) throw new Error("test: the slow rollout listing was used");
          return { data: threads.filter(item => params.cwd === undefined || item.cwd === params.cwd),
            nextCursor: null };
        case "thread/queue/list":
          if (!queueSupported) throw methodMissing(method);
          if (!threads.some(item => item.id === params.threadId)) {
            throw rpcError(-32602, "thread not found");
          }
          return { data: state.queue.filter(item => item.threadId === params.threadId)
            .map(({ threadId, ...item }) => item), nextCursor: null };
        case "thread/queue/add": {
          if (!queueSupported) throw methodMissing(method);
          const item = { threadId: params.threadId, id: `qs_${state.queue.length + 1}`,
            clientUserMessageId: params.clientUserMessageId, input: params.input };
          state.queue.push(item);
          const { threadId, ...queuedSubmission } = item;
          return { queuedSubmission };
        }
        default: throw methodMissing(method);
      }
    },
    async close() {},
  };
}

function thread(id, cwd, status = { type: "idle" }) {
  return { id, cwd, status, preview: SECRET_PREVIEW, canAcceptDirectInput: true,
    sessionId: id, cliVersion: "0.152.1" };
}

const capture = (peer, overrides = {}) => runCodexQueueCapture({ peer, clientVersion: "0.152.1",
  threadId: THREAD, cwd: CWD, messageId: "message_1", text: "untrusted body", ...overrides });

test("the minimum admits equal or newer stable versions and nothing else", () => {
  assert.equal(MINIMUM_VERSION, "0.152.1");
  assert.deepEqual(evaluateClientVersion("0.152.1", "0.152.1"), { ok: true, reasonCode: null });
  assert.deepEqual(evaluateClientVersion("0.160.0", "0.152.1"), { ok: true, reasonCode: null });
  assert.deepEqual(evaluateClientVersion("1.0.0", "0.152.1"), { ok: true, reasonCode: null });
  assert.deepEqual(evaluateClientVersion("0.152.0", "0.152.1"),
    { ok: false, reasonCode: "below_minimum_version" });
  assert.deepEqual(evaluateClientVersion("0.153.0-beta.1", "0.152.1"),
    { ok: false, reasonCode: "prerelease_not_captured" });
  assert.deepEqual(evaluateClientVersion("0.152.0.1", "0.152.1"),
    { ok: false, reasonCode: "prerelease_not_captured" });
  assert.deepEqual(evaluateClientVersion("unavailable", "0.152.1"),
    { ok: false, reasonCode: "version_unavailable" });
  assert.equal(compareStableVersions("0.10.0", "0.9.99"), 1);
  assert.equal(compareStableVersions("2.0.0", "10.0.0"), -1);
  assert.equal(compareStableVersions("0.152.1", "0.152.1"), 0);
});

test("the server version is read from the observed user-agent shape", () => {
  assert.equal(serverVersionOf(OBSERVED_USER_AGENT), "0.152.1");
  assert.equal(serverVersionOf("acc/0.153.0-alpha.1 (Mac OS)"), "0.153.0-alpha.1");
  assert.equal(serverVersionOf("codex_app_server/0.152.0"), "0.152.0");
  assert.equal(serverVersionOf("no version here"), null);
  assert.equal(serverVersionOf(undefined), null);
});

test("the probe rejects an app server that does not speak the captured queue protocol",
  async () => {
    const stale = fakePeer({ queueSupported: false });
    assert.deepEqual(await probeCodexQueue(stale, { clientVersion: "0.152.1", threadId: THREAD }),
      { supported: false, clientVersion: "0.152.1", serverVersion: "0.152.1",
        protocolContract: PROTOCOL_CONTRACT, modes: [], reasonCode: "protocol_mismatch" });
    const observed = fakePeer({ queueSupported: false, missingMethodCode: -32600 });
    assert.equal((await probeCodexQueue(observed, { clientVersion: "0.152.1", threadId: THREAD }))
      .reasonCode, "protocol_mismatch");
    assert.equal(isMethodMissing(rpcError(-32600, "Invalid request: unknown variant `x`")), true);
    assert.equal(isMethodMissing(rpcError(-32600, "invalid thread id: invalid character")), false);
    assert.equal(isMethodMissing(rpcError(-32603, "no rollout found for thread")), false);
    const older = fakePeer({ userAgent: "acc-native-delivery-capture/0.152.0 (Mac OS)" });
    assert.equal((await probeCodexQueue(older, { clientVersion: "0.152.1", threadId: THREAD }))
      .reasonCode, "below_minimum_version");
    const mismatch = fakePeer({ userAgent: "acc-native-delivery-capture/0.153.0 (Mac OS)" });
    assert.equal((await probeCodexQueue(mismatch, { clientVersion: "0.152.1", threadId: THREAD }))
      .reasonCode, "server_version_mismatch");
    const pre = fakePeer({ userAgent: "acc-native-delivery-capture/0.153.0-alpha.1 (Mac OS)" });
    assert.equal((await probeCodexQueue(pre, { clientVersion: "0.153.0-alpha.1", threadId: THREAD }))
      .reasonCode, "prerelease_not_captured");
  });

test("a supported probe reports the driver-facing closed result", async () => {
  const peer = fakePeer();
  assert.deepEqual(await probeCodexQueue(peer, { clientVersion: "0.152.1", threadId: THREAD }), {
    supported: true,
    clientVersion: "0.152.1",
    serverVersion: "0.152.1",
    protocolContract: PROTOCOL_CONTRACT,
    modes: ["livePush", "idleWake", "busyQueue"],
    reasonCode: null,
  });
  assert.deepEqual(peer.calls[0], { method: "initialize", params: {
    clientInfo: { name: "acc-native-delivery-capture", version: "0.0.0" },
    capabilities: { experimentalApi: true } } });
  assert.deepEqual(peer.calls[1], { method: "initialized", params: {}, notification: true });
  assert.deepEqual(peer.calls[2], { method: "thread/queue/list", params: { threadId: THREAD } });
});

test("the exact thread is discovered from loaded state rather than guessed", async () => {
  const peer = fakePeer({ loaded: ["thread-other", THREAD],
    threads: [thread("thread-other", "/work/other"), thread(THREAD, CWD)] });
  assert.deepEqual(await locateCodexThread(peer, { threadId: THREAD, cwd: CWD }),
    { found: true, threadId: THREAD, status: "idle" });
  assert.deepEqual(await locateCodexThread(peer, { threadId: "thread-missing", cwd: CWD }),
    { found: false, reasonCode: "thread_not_loaded" });
  assert.deepEqual(await locateCodexThread(peer, { threadId: THREAD, cwd: "/work/elsewhere" }),
    { found: false, reasonCode: "thread_not_found" });
  const list = peer.calls.filter(call => call.method === "thread/list").at(-1);
  assert.deepEqual(list.params, { limit: 100, useStateDbOnly: true, cwd: "/work/elsewhere" });
  const unlisted = fakePeer({ loaded: [THREAD], threads: [] });
  assert.deepEqual(await locateCodexThread(unlisted, { threadId: THREAD, cwd: CWD }),
    { found: false, reasonCode: "thread_not_found" });
  const busy = fakePeer({ threads: [thread(THREAD, CWD, { type: "active", activeFlags: [] })] });
  assert.deepEqual(await locateCodexThread(busy, { threadId: THREAD, cwd: CWD }),
    { found: true, threadId: THREAD, status: "active" });
});

test("discovery lists loaded threads with id, cwd, and status only", async () => {
  const peer = fakePeer({ loaded: [THREAD, "thread-other"],
    threads: [thread(THREAD, CWD), thread("thread-other", "/work/other",
      { type: "active", activeFlags: [] }), thread("thread-stored", "/work/old")] });
  const discovered = await discoverCodexThreads(peer);
  assert.deepEqual(discovered, [
    { threadId: THREAD, cwd: CWD, status: "idle" },
    { threadId: "thread-other", cwd: "/work/other", status: "active" },
  ]);
  assert.equal(JSON.stringify(discovered).includes(SECRET_PREVIEW), false);
});

test("a queue addition carries the captured shape and the stable message id", async () => {
  const peer = fakePeer();
  const result = await addCodexQueueMessage(peer, { threadId: THREAD, messageId: "message_1",
    text: "untrusted body" });
  assert.deepEqual(result, { accepted: true, duplicate: false, queuedSubmissionId: "qs_1",
    clientUserMessageId: "message_1" });
  const add = peer.calls.find(call => call.method === "thread/queue/add");
  assert.deepEqual(add.params, { threadId: THREAD,
    input: [{ type: "text", text: "untrusted body" }], clientUserMessageId: "message_1" });
});

test("a retry preserves the client message id and is the same offer", async () => {
  const peer = fakePeer();
  const first = await addCodexQueueMessage(peer, { threadId: THREAD, messageId: "message_1",
    text: "untrusted body" });
  const second = await addCodexQueueMessage(peer, { threadId: THREAD, messageId: "message_1",
    text: "untrusted body" });
  assert.equal(first.duplicate, false);
  assert.deepEqual(second, { accepted: true, duplicate: true, queuedSubmissionId: "qs_1",
    clientUserMessageId: "message_1" });
  assert.equal(peer.state.queue.length, 1);
  const adds = peer.calls.filter(call => call.method === "thread/queue/add");
  assert.deepEqual(adds.map(call => call.params.clientUserMessageId), ["message_1"]);
});

test("a duplicate acknowledgement from the server is the same offer", async () => {
  const peer = fakePeer({ queue: [{ threadId: THREAD, id: "qs_existing",
    clientUserMessageId: "message_1", input: [{ type: "text", text: "earlier" }] }] });
  const result = await addCodexQueueMessage(peer, { threadId: THREAD, messageId: "message_1",
    text: "untrusted body" });
  assert.deepEqual(result, { accepted: true, duplicate: true, queuedSubmissionId: "qs_existing",
    clientUserMessageId: "message_1" });
  assert.equal(peer.calls.some(call => call.method === "thread/queue/add"), false);
});

test("the capture returns closed safe results for every unavailable dependency", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  expectClosed(await capture(fakePeer({ transportError: refused })),
    { reasonCode: "transport_unavailable", stage: "initialize" });
  expectClosed(await capture(fakePeer({ loaded: [] })),
    { reasonCode: "thread_not_loaded", stage: "locate", serverVersion: "0.152.1" });
  expectClosed(await capture(fakePeer({ queueSupported: false })),
    { reasonCode: "protocol_mismatch", stage: "probe", serverVersion: "0.152.1" });
  const timeout = Object.assign(new Error("thread/queue/add timed out after 5ms"),
    { code: "ETIMEDOUT" });
  expectClosed(await capture(failingAt(fakePeer(), "thread/queue/add", timeout)),
    { reasonCode: "request_timeout", stage: "queue", serverVersion: "0.152.1",
      threadId: THREAD, threadStatus: "idle" });
  const vendor = rpcError(-32000, "internal: SECRET path /Users/x");
  const vendorResult = await capture(failingAt(fakePeer(), "thread/queue/add", vendor));
  assert.equal(vendorResult.reasonCode, "vendor_error");
  assert.equal(vendorResult.stage, "queue");
  assert.equal(JSON.stringify(vendorResult).includes("SECRET"), false);
});

function failingAt(peer, failingMethod, error) {
  const original = peer.request;
  peer.request = async (method, params) => {
    if (method === failingMethod) {
      peer.calls.push({ method, params });
      throw error;
    }
    return original(method, params);
  };
  return peer;
}

function expectClosed(actual, overrides) {
  const { at, ...rest } = actual;
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(rest, { supported: false, clientVersion: "0.152.1", serverVersion: null,
    protocolContract: PROTOCOL_CONTRACT, modes: [], threadId: null, threadStatus: null,
    queue: null, reasonCode: null, stage: null, ...overrides });
}

test("a complete capture never reads transcript content", async () => {
  const peer = fakePeer();
  const result = await capture(peer);
  assert.match(result.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(result, {
    at: result.at, supported: true, clientVersion: "0.152.1", serverVersion: "0.152.1",
    protocolContract: PROTOCOL_CONTRACT, modes: ["livePush", "idleWake", "busyQueue"],
    threadId: THREAD, threadStatus: "idle",
    queue: { accepted: true, duplicate: false, queuedSubmissionId: "qs_1",
      clientUserMessageId: "message_1" },
    reasonCode: null, stage: "complete",
  });
  const forbidden = new Set(["thread/read", "thread/items/list", "thread/turns/list",
    "thread/resume", "thread/start", "turn/start", "thread/queue/start"]);
  for (const call of peer.calls) assert.equal(forbidden.has(call.method), false, call.method);
  assert.equal(JSON.stringify(result).includes(SECRET_PREVIEW), false);
});

test("the command-line capture prints one closed JSON result from a fake client", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acc-codex-spike-"));
  const command = path.join(tempDir, "fake-codex.mjs");
  writeFileSync(command, `#!/usr/bin/env node
if (process.argv[2] === "--version") { process.stdout.write("codex-cli 0.152.0\\n"); process.exit(0); }
process.exit(9);
`, { mode: 0o700 });
  chmodSync(command, 0o700);
  try {
    const run = await runProcess([captureScript, "--thread", THREAD, "--message", "message_1",
      "--cwd", repoRoot], { env: { ACC_CODEX_SPIKE_COMMAND: command,
      ACC_CODEX_APP_SERVER_SOCKET: path.join(tempDir, "missing.sock") } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.result.supported, false);
    assert.equal(run.result.clientVersion, "0.152.0");
    assert.equal(run.result.reasonCode, "below_minimum_version");
    assert.equal(run.result.stage, "version");
    const usage = await runProcess([captureScript, "--thread", THREAD]);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /usage:/);
    const discover = await runProcess([captureScript, "--discover"],
      { env: { ACC_CODEX_SPIKE_COMMAND: command,
        ACC_CODEX_APP_SERVER_SOCKET: path.join(tempDir, "missing.sock") } });
    assert.equal(discover.code, 0, discover.stderr);
    assert.deepEqual(discover.result.loaded, []);
    assert.equal(discover.result.reasonCode, "transport_unavailable");
    assert.equal(discover.result.clientVersion, "0.152.0");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
