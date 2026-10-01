import { isLaunchOption } from "@agents-can-communicate/adapter-sdk";

// Shared presentation of observed delivery facts. Vendor probes provide closed
// reasons; installation and doctor must not turn a version floor into readiness.
const REASONS = Object.freeze({
  // Said of a client that has no live channel ACC supports.
  native_delivery_unsupported: "this client has no live delivery channel ACC supports here",
  version_unavailable: "the client version could not be verified",
  below_minimum_version: "the client is below the native delivery minimum version",
  known_bad_version: "this client version has a known native delivery failure",
  native_endpoint_unavailable: "the client's local delivery service is unavailable",
  native_session_unavailable: "the local delivery service has no loaded client session",
  feature_probe_failed: "the native protocol probe did not succeed",
  probe_timeout: "the native protocol probe timed out",
  probe_version_mismatch: "the local service and CLI versions differ",
  protocol_mismatch: "the local service did not confirm the required protocol",
  unsupported_shell: "automatic launch setup requires zsh",
  client_session_embedded: "the client runs this session on its own embedded service, which peers "
    + "cannot reach",
});

export function describeNativeReason(reason, { clientVersion, minimumVersion, launchOption } = {}) {
  if (reason === "below_minimum_version" && clientVersion && minimumVersion) {
    return `client ${clientVersion} needs version ${minimumVersion} or newer for native delivery`;
  }
  // A client can run embedded because of how it was started - Codex does for
  // `--search`, `-c`, `--profile` and others while its daemon runs.
  if (reason === "client_session_embedded" && isLaunchOption(launchOption)) {
    return `the client was started with ${launchOption}, which runs this session on its own `
      + "embedded service that peers cannot reach";
  }
  return REASONS[reason] ?? reason ?? "readiness is unverified";
}
export const describeDeliveryFallback = entry => entry.capabilities?.delivery?.nextTurn === true
  ? "next-turn hooks (when enabled) or acc inbox" : "acc inbox";

export function describeInstallDelivery(entry, policy, effectivePolicy) {
  const state = policy === "off" ? "off" : effectivePolicy === "off"
    ? `consent saved (${policy}); not active` : `enabled (${policy}); waiting for a verified session`;
  const reason = entry.nativeDelivery?.reasonCode;
  return `${entry.displayName ?? entry.adapterId} live delivery: ${state}`
    + (reason ? `; ${describeNativeReason(reason, { clientVersion: entry.version,
      minimumVersion: entry.nativeDelivery?.eligibility?.minimumVersion })}` : "")
    + `; fallback: ${describeDeliveryFallback(entry)}`;
}
