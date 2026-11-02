import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindNativeSession, offerMessage, refreshNativeSession } from "../src/web-delivery.mjs";
import { httpRequest } from "../src/web-client.mjs";
import { claimWake, readWakeOutcome, readWebEndpoint, recordWake, releaseWake }
  from "../src/web-endpoint.mjs";

const SERVER = "01JZX4A6E7M8V0R3Q0N2K2M5Q9";
const META_SERVER = "01JZX4A6E7M8V0R3Q0N2K2M5QA";
const SESSION = "session_test";
const VERSION = "2.4.0";
const envelope = (data, code = 0) => ({ status: 200,
  text: JSON.stringify({ code, msg: "success", data, request_id: "request_test" }) });
const prompt = (promptId, status) => ({ prompt_id: promptId, user_message_id: promptId,
  status, content: [{ type: "text", text: "wake" }], created_at: new Date().toISOString() });

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-kimi-web-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), runtimeDir = path.join(root, "runtime"), cwd = path.join(root, "cwd");
  const now = Date.now(), startedAt = now - 1_000;
  await Promise.all([mkdir(path.join(home, "server", "instances"), { recursive: true }),
    mkdir(path.join(home, "locks", "sessions"), { recursive: true }), mkdir(runtimeDir), mkdir(cwd)]);
  await writeFile(path.join(home, "server", "instances", `${SERVER}.json`), JSON.stringify({
    server_id: SERVER, pid: process.pid, host: "127.0.0.1", port: 59631, started_at: startedAt,
    heartbeat_at: now, host_version: VERSION }), { mode: 0o600 });
  await writeFile(path.join(home, "locks", "sessions", `${SESSION}.lock`), JSON.stringify({
    version: 1, token: `${process.pid}:123e4567-e89b-42d3-a456-426614174000`, pid: process.pid,
    hostname: os.hostname(), startedAt: now, clientIdentity: "kimi_code_cli",
    clientDisplayName: "Kimi Code Web", ...overrides.lock }), { mode: 0o600 });
  await writeFile(path.join(home, "server.token"), "first-token", { mode: 0o600 });
  const calls = [];
  const request = async input => {
    calls.push(input);
    if (input.path === "/api/v1/meta") return envelope({ server_version: VERSION,
      server_id: META_SERVER, started_at: new Date(startedAt + 145).toISOString(),
      dangerous_bypass_auth: overrides.bypass === true });
    if (input.path.endsWith("/status")) return envelope({ permission: overrides.permission ?? "yolo" });
    if (input.path === `/api/v1/sessions/${SESSION}`) return envelope({ id: SESSION,
      archived: false, metadata: { cwd: overrides.foreignCwd ? path.join(root, "other") : cwd },
      agent_config: { model: overrides.cold ? "" : "local" } });
    if (input.method === "GET") return envelope({ active: overrides.busy ? prompt("user", "running") : null,
      queued: [] });
    if (overrides.submitTimeout) return { error: { code: "ETIMEDOUT" } };
    return envelope(prompt("message_test", overrides.blocked ? "blocked"
      : overrides.queued || overrides.busy ? "queued" : "running"));
  };
  const options = { env: { KIMI_CODE_HOME: home }, runtimeDir, request, hostname: os.hostname(),
    exists: () => true, now: () => now };
  return { root, home, runtimeDir, cwd, now, startedAt, calls, options, state: overrides };
}

const event = cwd => ({ sessionId: SESSION, cwd });
const bind = f => bindNativeSession({ ...f.options, event: event(f.cwd), clientPid: process.pid,
  clientVersion: VERSION });

test("bind verifies the generation and stores no token", async t => {
  const f = await fixture(t);
  const bound = await bind(f);
  assert.equal(bound.supported, true, bound.reasonCode);
  assert.deepEqual(bound.modes, ["livePush", "idleWake"]);
  const record = await readWebEndpoint({ runtimeDir: f.runtimeDir,
    endpointId: bound.opaqueEndpointRef });
  assert.equal(record.cwd, f.cwd);
  assert.equal(JSON.stringify(record).includes("first-token"), false);
  assert.equal((await refreshNativeSession({ ...f.options, binding: bound })).supported, true);
});

test("idle delivery posts only a fixed wake and message id", async t => {
  const f = await fixture(t);
  const bound = await bind(f);
  const beforeOffer = f.calls.length;
  const result = await offerMessage({ ...f.options, binding: bound,
    message: { messageId: "message_test" } });
  assert.equal(result.accepted, true);
  assert.equal(result.queueStatus, undefined);
  const offerCalls = f.calls.slice(beforeOffer);
  const statusAt = offerCalls.findIndex(call => call.path.endsWith("/status"));
  const postAt = offerCalls.findIndex(call => call.method === "POST");
  assert.ok(statusAt >= 0 && statusAt < postAt, "permission is read just before the wake is submitted");
  const submitted = f.calls.find(call => call.method === "POST");
  const body = JSON.parse(submitted.body);
  assert.equal(body.prompt_id, "message_test");
  assert.match(body.content[0].text, /message_test/);
  assert.deepEqual(Object.keys(body), ["content", "prompt_id"]);
});

test("a wake accepted behind busy work is queued, never woken", async t => {
  for (const overrides of [{ busy: true }, { queued: true }, { blocked: true }]) {
    const f = await fixture(t, overrides);
    const bound = await bind(f);
    const result = await offerMessage({ ...f.options, binding: bound,
      message: { messageId: "message_test" } });
    assert.equal(result.accepted, true);
    assert.equal(result.queueStatus, "queued");
    assert.equal(f.calls.some(call => call.method === "POST"), true);
  }
});

test("lock mismatch and unsafe auth fail closed without prompt APIs", async t => {
  for (const overrides of [{ lock: { pid: process.ppid,
    token: `${process.ppid}:123e4567-e89b-42d3-a456-426614174000` } }, { bypass: true },
  { permission: "manual" }]) {
    const f = await fixture(t, overrides);
    const bound = await bind(f);
    assert.equal(bound.supported, false);
    assert.equal(f.calls.some(call => call.path.includes("/prompts")), false);
  }
});

test("a missing initial lock fails closed but a later warm lease survives lock release", async t => {
  const cold = await fixture(t);
  await rm(path.join(cold.home, "locks", "sessions", `${SESSION}.lock`));
  const refused = await bindNativeSession({ ...cold.options, event: { ...event(cold.cwd),
    kind: "sessionStart" }, clientPid: process.pid, clientVersion: VERSION });
  assert.equal(refused.supported, false);
  assert.equal(cold.calls.some(call => call.path.includes("/prompts")), false);

  const warm = await fixture(t);
  const bound = await bind(warm);
  await rm(path.join(warm.home, "locks", "sessions", `${SESSION}.lock`));
  const result = await offerMessage({ ...warm.options, binding: bound,
    message: { messageId: "message_test" } });
  assert.equal(result.accepted, true);
});

test("initial model selection may finish after binding, but no offer runs before it", async t => {
  const f = await fixture(t, { cold: true });
  const bound = await bindNativeSession({ ...f.options, event: { ...event(f.cwd), kind: "sessionStart" },
    clientPid: process.pid, clientVersion: VERSION });
  assert.equal(bound.supported, true, bound.reasonCode);
  f.calls.length = 0;
  const result = await offerMessage({ ...f.options, binding: bound,
    message: { messageId: "message_test" } });
  assert.equal(result.accepted, false);
  assert.equal(f.calls.some(call => call.path.endsWith("/status")), false);
  assert.equal(f.calls.some(call => call.path.includes("/prompts")), false);
});

test("a reclaimed session or changed cwd is refused before any resume-capable request", async t => {
  for (const change of ["cold", "foreignCwd"]) {
    const f = await fixture(t);
    const bound = await bind(f);
    f.state[change] = true;
    f.calls.length = 0;
    const result = await offerMessage({ ...f.options, binding: bound,
      message: { messageId: "message_test" } });
    assert.equal(result.accepted, false);
    assert.equal(result.safeErrorCode, "recipient_unavailable");
    assert.equal(f.calls.some(call => call.path.endsWith("/status")), false);
    assert.equal(f.calls.some(call => call.path.includes("/prompts")), false);
  }
});

test("an ambiguous submit is never blindly retried and token rotates per offer", async t => {
  const f = await fixture(t, { submitTimeout: true });
  const bound = await bind(f);
  const first = await offerMessage({ ...f.options, binding: bound,
    message: { messageId: "message_test" } });
  assert.equal(first.safeErrorCode, "transport_error");
  const posts = f.calls.filter(call => call.method === "POST").length;
  await writeFile(path.join(f.home, "server.token"), "rotated-token", { mode: 0o600 });
  const second = await offerMessage({ ...f.options, binding: bound,
    message: { messageId: "message_test" } });
  // The prompt may not exist, so the duplicate claims no queued wake either.
  assert.equal(second.accepted, false);
  assert.equal(second.safeErrorCode, "transport_error");
  assert.equal(second.queueStatus, undefined);
  assert.equal(f.calls.filter(call => call.method === "POST").length, posts);
  assert.equal(JSON.stringify(await readFile(path.join(f.runtimeDir, "kimi-web-endpoints",
    `${bound.opaqueEndpointRef}.json`), "utf8")).includes("rotated-token"), false);
});

test("file permissions are private where the client requires them", {
  skip: process.platform === "win32" ? "Windows does not enforce POSIX file modes" : false,
}, async t => {
  const f = await fixture(t);
  await chmod(path.join(f.home, "server.token"), 0o644);
  const bound = await bind(f);
  assert.equal(bound.supported, false);
  assert.equal(f.calls.length, 0);
});

test("an authorization failure uses the closed handshake reason vocabulary", async t => {
  const f = await fixture(t);
  const bound = await bindNativeSession({ ...f.options,
    request: async () => ({ status: 401, text: "" }), event: event(f.cwd),
    clientPid: process.pid, clientVersion: VERSION });
  assert.equal(bound.supported, false);
  assert.equal(bound.reasonCode, "handshake_failed");
});

test("a non-loopback host is refused before any socket is opened", async () => {
  const result = await httpRequest({ method: "GET", host: "example.com", port: 443, path: "/" });
  assert.equal(result.error.code, "EACCES");
});

test("an expired or mismatched lease cannot submit a prompt", async t => {
  const f = await fixture(t);
  const bound = await bind(f);
  const beforeOffers = f.calls.length;
  const expired = await offerMessage({ ...f.options,
    binding: { ...bound, leaseUntil: new Date(f.now - 1).toISOString() },
    message: { messageId: "message_test" } });
  assert.equal(expired.safeErrorCode, "recipient_unavailable");
  assert.equal(f.calls.length, beforeOffers,
    "an expired lease must not resume a session through a status probe");

  const mismatched = await offerMessage({ ...f.options,
    binding: { ...bound, leaseUntil: new Date(f.now + 60_000).toISOString() },
    message: { messageId: "message_test" } });
  assert.equal(mismatched.safeErrorCode, "recipient_unavailable");
  assert.equal(f.calls.length, beforeOffers,
    "a superseded lease must not resume a session through a status probe");
});

test("a session switched out of yolo after binding gets no wake", async t => {
  for (const permission of ["manual", "auto"]) {
    const f = await fixture(t);
    const bound = await bind(f);
    f.state.permission = permission;
    f.calls.length = 0;
    const result = await offerMessage({ ...f.options, binding: bound,
      message: { messageId: "message_test" } });
    assert.equal(result.accepted, false, permission);
    assert.equal(result.safeErrorCode, "recipient_unavailable");
    assert.equal(f.calls.some(call => call.method === "POST"), false);
    // The marker was released: a later yolo offer for the same message submits.
    f.state.permission = "yolo";
    const retry = await offerMessage({ ...f.options, binding: bound,
      message: { messageId: "message_test" } });
    assert.equal(retry.accepted, true);
    assert.equal(f.calls.some(call => call.method === "POST"), true);
  }
});

test("a cold session is rejected before the status route is read", async t => {
  const f = await fixture(t);
  const bound = await bind(f);
  f.state.cold = true;
  f.calls.length = 0;
  const result = await offerMessage({ ...f.options, binding: bound,
    message: { messageId: "message_test" } });
  assert.equal(result.accepted, false);
  assert.equal(f.calls.some(call => call.path.endsWith("/status")), false);
});

test("a duplicate offer repeats the first submit outcome", async t => {
  for (const [overrides, queued] of [[{}, false], [{ busy: true }, true]]) {
    const f = await fixture(t, overrides);
    const bound = await bind(f);
    const message = { messageId: "message_test" };
    const first = await offerMessage({ ...f.options, binding: bound, message });
    const posts = f.calls.filter(call => call.method === "POST").length;
    const second = await offerMessage({ ...f.options, binding: bound, message });
    assert.equal(second.accepted, true);
    assert.equal(first.queueStatus, queued ? "queued" : undefined);
    assert.equal(second.queueStatus, first.queueStatus);
    assert.equal(f.calls.filter(call => call.method === "POST").length, posts);
  }
});

const wakeFixture = async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-kimi-wake-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "workspace", "runtime");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const wake = { runtimeDir, endpointId: `kimi_web_${"a".repeat(32)}`, messageId: "message_link" };
  const file = name => path.join(runtimeDir, "kimi-web-wakes", wake.endpointId, name);
  return { root, wake, file };
};

test("a wake outcome is kept once beside its marker and leaves with it", async t => {
  const { wake, file } = await wakeFixture(t);
  assert.equal(await claimWake(wake), true);
  assert.equal(await readWakeOutcome(wake), null, "unresolved until the first submit ends");
  await recordWake({ ...wake, outcome: "running" });
  assert.equal(await readWakeOutcome(wake), "running");
  // The first outcome is the one a duplicate repeats; a later write changes nothing.
  await recordWake({ ...wake, outcome: "queued" });
  assert.equal(await readWakeOutcome(wake), "running");
  assert.equal(await readFile(file(wake.messageId), "utf8"), "", "the marker itself stays empty");
  // An outcome is never invented for a marker that does not exist.
  const missing = { ...wake, messageId: "message_absent" };
  await recordWake({ ...missing, outcome: "running" });
  assert.equal(await readWakeOutcome(missing), null);
  // Releasing the wake takes its outcome too, so a new claim starts unresolved.
  await releaseWake(wake);
  assert.equal(await claimWake(wake), true);
  assert.equal(await readWakeOutcome(wake), null);
});

test("a wake outcome is never read or written through a link", {
  skip: process.platform === "win32" ? "symbolic links need privileges on Windows" : false,
}, async t => {
  const { symlink } = await import("node:fs/promises");
  const { root, wake, file } = await wakeFixture(t);
  const victim = path.join(root, "victim");
  await writeFile(victim, "running");
  assert.equal(await claimWake(wake), true);
  // A link planted where the outcome goes is neither followed nor replaced.
  await symlink(victim, file(`${wake.messageId}.outcome`));
  await recordWake({ ...wake, outcome: "queued" });
  assert.equal(await readFile(victim, "utf8"), "running");
  assert.equal(await readWakeOutcome(wake), null);
  // A marker replaced by a link is no claim to record against.
  const other = { ...wake, messageId: "message_other" };
  assert.equal(await claimWake(other), true);
  await rm(file(other.messageId));
  await symlink(victim, file(other.messageId));
  await recordWake({ ...other, outcome: "queued" });
  assert.equal(await readWakeOutcome(other), null);
  assert.equal(await readFile(victim, "utf8"), "running");
});

test("a duplicate of an offer still deciding is not reported as accepted", async t => {
  const f = await fixture(t);
  const bound = await bind(f);
  // The first offer holds the marker and has not yet submitted or refused.
  assert.equal(await claimWake({ runtimeDir: f.runtimeDir, endpointId: bound.opaqueEndpointRef,
    messageId: "message_test" }), true);
  const posts = f.calls.filter(call => call.method === "POST").length;
  const duplicate = await offerMessage({ ...f.options, binding: bound,
    message: { messageId: "message_test" } });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.safeErrorCode, "recipient_busy");
  assert.equal(f.calls.filter(call => call.method === "POST").length, posts);
  // Once that first offer refuses and releases its claim, the next offer submits.
  await releaseWake({ runtimeDir: f.runtimeDir, endpointId: bound.opaqueEndpointRef,
    messageId: "message_test" });
  const next = await offerMessage({ ...f.options, binding: bound, message: { messageId: "message_test" } });
  assert.equal(next.accepted, true);
  assert.equal(f.calls.filter(call => call.method === "POST").length, posts + 1);
});
