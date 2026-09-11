import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { nativeRemediation } from "../src/native-delivery-status.mjs";
import { describeNative } from "../src/doctor-command.mjs";
import { nativeSessionLines, updateNativeSessions } from "../src/native-session-diagnostics.mjs";

// Doctor's old answer came from the binding record alone: present, policy on,
// lease not yet expired. That is handshake state, not deliverability, and on a
// machine where every send fell back to durable it still read "local transport
// active". These cases hold the report to what the receiver can actually take.

const NOW = "2026-09-02T12:00:00.000Z";
const LEASE = "2026-09-02T12:01:00.000Z";
const BOUND = "0.153.4";

async function runtimeDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "acc-doctor-deliverability-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const entry = () => ({ adapterId: "codex", displayName: "Codex CLI", present: true, installed: true,
  nativeDelivery: { eligibility: "eligible", configured: true, policy: "actionable",
    policySource: "installation-record", runtime: "active", modes: ["livePush"],
    reasonCode: null, minimumVersion: "0.152.1", activation: "not_required",
    sessionPolicy: "actionable" } });

const service = (leaseUntil = LEASE) => ({
  locateSession: async sessionId => ({ record: { sessionId, state: "open",
    generation: "generation_a" } }),
  listDeliveryBindings: async () => [{ sessionId: "session_a", generation: "generation_a",
    adapterId: "codex", clientVersion: BOUND, availableModes: ["livePush"],
    livePolicy: "actionable", opaqueEndpointRef: "codex_endpoint_ref", leaseUntil }],
});

const status = { participants: [{ sessionId: "session_a", participantId: "reviewer",
  harness: "codex", presence: "live" }] };

const adapterThat = refreshNativeSession => ({ id: "codex", refreshNativeSession });

async function report(t, adapter, { leaseUntil } = {}) {
  const adapters = [entry()];
  await updateNativeSessions(adapters, { service: service(leaseUntil), status,
    root: await runtimeDir(t), now: NOW, registry: adapter === null ? [] : [adapter] });
  return { adapters, lines: nativeSessionLines(adapters) };
}

test("a binding whose receiver refuses is reported degraded, not as an active transport",
  async t => {
    // Everything the old rule looked at still says healthy: the binding is
    // there, livePush is offered, the policy is on and the lease has a minute
    // left. The receiver is the only thing that knows better.
    const { adapters, lines } = await report(t, adapterThat(async () => ({ supported: false,
      clientVersion: null, protocolContract: "codex-app-server-thread-queue-v1", modes: [],
      opaqueEndpointRef: null, leaseUntil: null, reasonCode: "handshake_version_mismatch" })));
    const [session] = adapters[0].nativeDelivery.sessions;
    assert.equal(session.runtime, "degraded");
    assert.deepEqual(session.delivery, { deliverable: false,
      reasonCode: "handshake_version_mismatch", clientVersion: null });
    // The adapter's own line is what a reader sees first, so it must stop
    // claiming health too.
    assert.equal(adapters[0].nativeDelivery.runtime, "degraded");
    assert.equal(describeNative(adapters[0].nativeDelivery),
      "available; enabled (actionable); channel unreachable");
    // The condition is named, in the vocabulary doctor already speaks, and so
    // is something to do about it.
    assert.match(lines[0], /no live delivery: the version now serving is below the captured/);
    assert.match(lines[0], /restart the client's local delivery service/);
    assert.match(nativeRemediation(adapters[0]).join("\n"),
      /no verified live channel in this workspace/);
  });

test("an unreachable receiver is a refusal, not a crash, whatever the adapter does", async t => {
  for (const refresh of [async () => { throw new Error("socket /secret/path refused"); },
    async () => undefined]) {
    const { adapters, lines } = await report(t, adapterThat(refresh));
    assert.equal(adapters[0].nativeDelivery.sessions[0].runtime, "degraded");
    assert.equal(adapters[0].nativeDelivery.sessions[0].delivery.reasonCode, "handshake_failed");
    assert.equal(lines.join("\n").includes("secret"), false);
  }
});

test("a verified receiver stays active and names a service that moved under its binding",
  async t => {
    const { adapters, lines } = await report(t, adapterThat(async () => ({ supported: true,
      clientVersion: "0.154.0", protocolContract: "codex-app-server-thread-queue-v1",
      modes: ["livePush", "idleWake", "busyQueue"], opaqueEndpointRef: "codex_endpoint_ref",
      leaseUntil: LEASE, reasonCode: null })));
    assert.equal(adapters[0].nativeDelivery.sessions[0].runtime, "active");
    assert.equal(adapters[0].nativeDelivery.runtime, "active");
    // The binding records the version admitted when it was published; the
    // receiver answers with what is serving now. A difference the contract
    // still admits is information, not a refusal - and saying it is how the
    // two records stop being invisible to the person reading this.
    assert.match(lines[0],
      /local transport active; receiver verified, now serving 0\.154\.0 where this binding recorded 0\.153\.4/);
  });

test("an adapter that cannot re-verify keeps the lease answer rather than being refused",
  async t => {
    // Every adapter but Codex is in this position today. Reporting "degraded"
    // because nothing could be asked would be a different false report.
    const { adapters, lines } = await report(t, null);
    assert.equal(adapters[0].nativeDelivery.sessions[0].delivery, null);
    assert.equal(adapters[0].nativeDelivery.sessions[0].runtime, "active");
    assert.equal(adapters[0].nativeDelivery.runtime, "active");
    assert.doesNotMatch(lines[0], /receiver verified|no live delivery/);
  });

test("an expired lease is already degraded and is never re-verified over the wire", async t => {
  let asked = 0;
  const { adapters } = await report(t, adapterThat(async () => { asked += 1;
    return { supported: true, clientVersion: BOUND, protocolContract: "x", modes: ["livePush"],
      opaqueEndpointRef: "codex_endpoint_ref", leaseUntil: LEASE, reasonCode: null }; }),
  { leaseUntil: "2026-09-02T11:59:00.000Z" });
  assert.equal(adapters[0].nativeDelivery.sessions[0].runtime, "degraded");
  assert.equal(adapters[0].nativeDelivery.sessions[0].delivery, null);
  assert.equal(asked, 0);
});
