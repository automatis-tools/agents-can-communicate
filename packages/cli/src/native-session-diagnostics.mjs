import { listSessionBindings, loadNativeAttempt } from "@agents-can-communicate/adapter-sdk";
import { describeNativeReason } from "@agents-can-communicate/installer";

// Session diagnostics are read only here, never projected into agent context.
// Verify the owner generation against core before attributing any last attempt.
export async function updateNativeSessions(adapters, { service, status, root, now }) {
  const owners = await listSessionBindings({ runtimeDir: root }).catch(() => []);
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
      const runtime = native.policySource === "installation-record" && !native.configured
        ? "inactive" : !binding ? "unbound"
          : Date.parse(binding.leaseUntil) > Date.parse(now) ? "active" : "degraded";
      native.sessions.push({ sessionId: peer.sessionId, participantId: peer.participantId,
        presence: peer.presence, runtime,
        lastAttempt: owner === null ? null : await loadNativeAttempt({ runtimeDir: root, ...owner }) });
    }
  }
}

const failures = {
  client_process_unknown: "the client process could not be identified; start a new client session",
  handshake_failed: "the session handshake failed; check the client's integration/channel setup",
  handshake_timeout: "the session handshake timed out; check the local channel and retry on the next turn",
  handshake_version_mismatch: "the session and CLI versions differ; start a new client session",
  session_generation_stale: "the session was replaced during the handshake",
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

export function nativeSessionLines(adapters) {
  return adapters.flatMap(entry => (entry.nativeDelivery.sessions ?? []).map(session =>
    `  ${entry.displayName} session ${session.participantId} (${session.sessionId}): `
    + `${session.runtime === "active" ? "local transport active" : session.runtime}; `
    + describeAttempt(session.lastAttempt)));
}
