// Shared presentation of observed delivery facts. Vendor probes provide closed
// reasons; installation and doctor must not turn a version floor into readiness.
const REASONS = Object.freeze({
  native_delivery_unsupported: "this adapter has no native delivery channel",
  platform_not_captured: "native delivery is not verified on this platform",
  version_unavailable: "the client version could not be verified",
  prerelease_not_captured: "this client version is not a verified stable release",
  below_minimum_version: "the client is below the native delivery minimum version",
  known_bad_version: "this client version has a known native delivery failure",
  native_endpoint_unavailable: "the client's local delivery service is unavailable",
  native_session_unavailable: "the local delivery service has no loaded client session",
  feature_probe_failed: "the native protocol probe did not succeed",
  probe_timeout: "the native protocol probe timed out",
  probe_version_mismatch: "the local service and CLI versions differ",
  protocol_mismatch: "the local service did not confirm the required protocol",
  unsupported_shell: "automatic launch setup requires zsh",
});

export const describeNativeReason = reason => REASONS[reason] ?? reason ?? "readiness is unverified";
export const describeDeliveryFallback = entry => entry.capabilities?.delivery?.nextTurn === true
  ? "next-turn hooks (when enabled) or acc inbox" : "acc inbox";

export function describeInstallDelivery(entry, policy, effectivePolicy) {
  const state = policy === "off" ? "off" : effectivePolicy === "off"
    ? `consent saved (${policy}); not active` : `enabled (${policy}); waiting for a verified session`;
  const reason = entry.nativeDelivery?.reasonCode;
  return `${entry.displayName ?? entry.adapterId} live delivery: ${state}`
    + (reason ? `; ${describeNativeReason(reason)}` : "")
    + `; fallback: ${describeDeliveryFallback(entry)}`;
}
