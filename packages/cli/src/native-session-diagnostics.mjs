import { listSessionBindings, loadNativeAttempt } from "@agents-can-communicate/adapter-sdk";
import { describeNativeReason } from "@agents-can-communicate/installer";

// One re-verification per bound session, well inside a doctor run's budget.
const VERIFY_TIMEOUT_MS = 750;

// A lease is not deliverability.
//
// Doctor used to answer "local transport active" from the binding record
// alone: present, policy on, lease not yet expired. All three can hold while
// every single send falls back to durable, because none of them says the
// receiver that binding names can still be reached. Measured exactly that way
// - `Codex CLI live delivery: available; enabled (actionable); local transport
// active` on a machine where live delivery had never once worked.
//
// So ask the adapter the question the router asks: its own bounded
// re-verification of this exact binding, which resolves the opaque reference
// to the receiver record, checks the socket, and re-reads the version,
// protocol, thread and workspace from the process that would actually serve
// the push. Read-only - it writes no record and renews no lease - and it
// answers in the closed reason-code vocabulary doctor already speaks. An
// adapter with no such method gets no verdict and keeps the lease answer.
async function verifyDelivery(adapter, { binding, runtimeDir }) {
  if (typeof adapter?.refreshNativeSession !== "function") return null;
  try {
    const handshake = await adapter.refreshNativeSession({ binding, runtimeDir,
      timeoutMs: VERIFY_TIMEOUT_MS });
    return handshake?.supported === true
      ? { deliverable: true, reasonCode: null, clientVersion: handshake.clientVersion ?? null }
      : { deliverable: false, reasonCode: handshake?.reasonCode ?? "handshake_failed",
        clientVersion: null };
  } catch {
    return { deliverable: false, reasonCode: "handshake_failed", clientVersion: null };
  }
}

// Session diagnostics are read only here, never projected into agent context.
// Verify the owner generation against core before attributing any last attempt.
export async function updateNativeSessions(adapters, { service, status, root, now,
  registry = [] }) {
  const owners = await listSessionBindings({ runtimeDir: root }).catch(() => []);
  const byAdapterId = new Map((registry ?? []).map(adapter => [adapter.id, adapter]));
  const transports = new Map();
  for (const entry of adapters) {
    const native = entry.nativeDelivery;
    native.sessions = [];
    if (native.reasonCode === "native_delivery_unsupported") continue;
    for (const peer of status.participants.filter(p => p.harness === entry.adapterId)) {
      const current = (await service.locateSession(peer.sessionId))?.record;
      if (current?.state !== "open") continue;
      const matches = owners.filter(owner => owner.accSessionId === peer.sessionId
        && owner.generation === current.generation);
      const owner = matches.length === 1 ? matches[0] : null;
      if (!transports.has(peer.participantId)) {
        transports.set(peer.participantId, await service.listDeliveryBindings({
          participantId: peer.participantId, now, includeExpired: true }));
      }
      const binding = transports.get(peer.participantId).find(b => b.sessionId === peer.sessionId
        && b.generation === current.generation && b.adapterId === entry.adapterId
        && b.availableModes.includes("livePush"));
      const off = native.policySource === "installation-record" && !native.configured;
      const leased = binding !== undefined && Date.parse(binding.leaseUntil) > Date.parse(now);
      // Only where the old rule would have said "active": everywhere else the
      // answer is already degraded or unbound, and a live check would buy
      // nothing but a socket round trip.
      const delivery = off || !leased ? null
        : await verifyDelivery(byAdapterId.get(entry.adapterId), { binding, runtimeDir: root });
      const runtime = off ? "inactive"
        : binding === undefined ? "unbound"
          : leased && (delivery === null || delivery.deliverable) ? "active" : "degraded";
      native.sessions.push({ sessionId: peer.sessionId, participantId: peer.participantId,
        presence: peer.presence, runtime, clientVersion: binding?.clientVersion ?? null, delivery,
        lastAttempt: owner === null ? null : await loadNativeAttempt({ runtimeDir: root, ...owner }) });
    }
    // The adapter's own line is the one a reader sees first, and it was the
    // one claiming health while nothing could be delivered. If this adapter
    // has bound sessions in this workspace and not one of them can take a
    // push, this is not an active transport.
    if (native.runtime === "active" && native.sessions.length > 0
      && !native.sessions.some(session => session.runtime === "active")) {
      native.runtime = "degraded";
    }
  }
}

const failures = {
  client_process_unknown: "the client process could not be identified; start a new client session",
  handshake_failed: "the session handshake failed; check the client's integration/channel setup",
  handshake_timeout: "the session handshake timed out; check the local channel and retry on the next turn",
  // Since the contract gate shipped, this reason means the version now serving
  // is below the captured minimum - not that two reported versions differ.
  // A daemon serving an older build than its CLI is ordinary and admitted; the
  // fix for this one is to restart the service onto the build the CLI has.
  handshake_version_mismatch: "the version now serving is below the captured native delivery "
    + "minimum; restart the client's local delivery service",
  session_generation_stale: "the session was replaced during the handshake",
  workspace_identity_unavailable: "the bound client session is no longer in this workspace; "
    + "start a new client session here",
};

function describeAttempt(attempt) {
  if (attempt === null) return "no native binding attempt observed for this generation; "
    + "check client hooks; an older hook runtime or a failed diagnostic write can also leave no record";
  let detail;
  if (attempt.state === "off") {
    const source = attempt.policySource === "bootstrap-environment" ? "launch" : "installation";
    detail = attempt.policyStatus === "missing" ? `${source} delivery policy was absent`
      : attempt.policyStatus === "invalid" ? `${source} delivery policy was invalid`
        : attempt.policyStatus === "unavailable" ? `${source} delivery policy could not be read`
          : `${source} delivery policy was off`;
  } else if (attempt.state === "active") detail = "local handshake succeeded";
  else detail = failures[attempt.reasonCode] ?? describeNativeReason(attempt.reasonCode);
  return `last attempt ${attempt.at}: ${detail}`;
}

// The two records this joins are the delivery binding core published and the
// receiver the adapter privately holds. Naming a difference between them is
// the point: one that still delivers is information about a service that
// updated under its binding, and one that does not is the whole reason a send
// falls back, said where a reader can act on it.
function describeDelivery(session) {
  const delivery = session.delivery;
  if (delivery === null || delivery === undefined) return null;
  if (!delivery.deliverable) {
    return "no live delivery: "
      + (failures[delivery.reasonCode] ?? describeNativeReason(delivery.reasonCode));
  }
  return delivery.clientVersion !== null && delivery.clientVersion !== session.clientVersion
    ? `receiver verified, now serving ${delivery.clientVersion} `
      + `where this binding recorded ${session.clientVersion}`
    : "receiver verified";
}

export function nativeSessionLines(adapters) {
  return adapters.flatMap(entry => (entry.nativeDelivery.sessions ?? []).map(session =>
    `  ${entry.displayName} session ${session.participantId} (${session.sessionId}): `
    + `${session.runtime === "active" ? "local transport active" : session.runtime}; `
    + [describeDelivery(session), describeAttempt(session.lastAttempt)]
      .filter(part => part !== null).join("; ")));
}
